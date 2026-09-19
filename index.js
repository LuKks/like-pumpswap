const PublicKey = require('solana-public-key')
const Borsh = require('borsh-encoding')

const TransactionInstruction = require('solana-transaction-instruction')
const SystemProgram = require('solana-system-program')
const TokenProgram = require('solana-token-program')

const IDL_PUMP_AMM = require('./idl.json')
const IDL_SPL_TOKEN = require('./idl-token.json')

const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111')
const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112')

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')

const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')
const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA')
const PUMP_FEE_PROGRAM_ID = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ')

const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const PDA_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const POOL_ACCOUNT_NEW_SIZE = 300
const POOL_ACCOUNT_SIZE = 270
const GLOBAL_CONFIG_ACCOUNT_SIZE = 949
const FEE_CONFIG_SIZE_PRE_STABLE = 2512
const FEE_CONFIG_SIZE_POST_STABLE = 4073
const FEE_CONFIG_SIZE_POST_EXOTIC = 4097
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
const NATIVE_MINT_2022 = new PublicKey('9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP')

const pools = new Map()

module.exports = class Pumpswap {
  constructor (rpc, opts = {}) {
    this.rpc = rpc

    // TODO: Use structs to optimize size
    this.borsh = {
      amm: new Borsh(IDL_PUMP_AMM),
      token: new Borsh(IDL_SPL_TOKEN)
    }

    this.global = Pumpswap.global()
    this.feeConfig = null

    this.programId = opts.programId || PUMP_AMM_PROGRAM_ID

    this.opened = false
    this.opening = this.ready()
    this.opening.then(() => {
      this.opened = true
    }).catch(noop)
  }

  static PROGRAM_ID = PUMP_AMM_PROGRAM_ID
  static IDL = IDL_PUMP_AMM

  static poolAddress (mint, quoteMint) {
    return canonicalPumpPoolPda(new PublicKey(mint), quoteMint)[0]
  }

  static price (reserves) {
    if (reserves.baseReserve === 0n) {
      return 0n
    }

    const quoteReserve = reserves.quoteReserve + (reserves.virtualQuoteReserves || 0n)

    return (quoteReserve * 1_000_000_000n) / reserves.baseReserve
  }

  static marketCap (reserves) {
    if (reserves.baseReserve === 0n) {
      return 0n
    }

    const tokenTotalSupply = reserves.isMayhemMode
      ? 1_000_000_000_000_000n
      : (reserves.tokenTotalSupply || 1_000_000_000_000_000n)
    const quoteReserve = reserves.quoteReserve + (reserves.virtualQuoteReserves || 0n)

    return (tokenTotalSupply * quoteReserve) / reserves.baseReserve
  }

  static global () {
    const defaultKey = PublicKey.default.toBase58()

    return {
      admin: 'FFWtrEQ4B4PKQoVuHYzZq8FabGkVatYzDpEVHsK5rrhF',
      lp_fee_basis_points: 20n,
      protocol_fee_basis_points: 5n,
      disable_flags: 0,
      protocol_fee_recipients: [
        '62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV',
        '7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ',
        '7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX',
        '9rPYyANsfQZw3DnDmKE3YCQF5E8oD89UXoHn9JFEhJUz',
        'AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY',
        'FWsW1xNtWscwNmKv6wVsU1iTzRN6wmmk3MjxRP5tT7hz',
        'G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP',
        'JCRGumoE9Qi5BBgULTgdgTLjSgkCMSbF62ZZfGs84JeU'
      ],
      coin_creator_fee_basis_points: 5n,
      admin_set_coin_creator_authority: defaultKey,
      whitelist_pda: defaultKey,
      reserved_fee_recipient: defaultKey,
      mayhem_mode_enabled: false,
      reserved_fee_recipients: Array(7).fill(defaultKey),
      is_cashback_enabled: false,
      buyback_fee_recipients: Array(8).fill(defaultKey),
      buyback_basis_points: 0n,
      boost_authority: defaultKey,
      boost_enabled: false,
      creator_fee_configurable: false,
      max_configurable_creator_fee_bps: 0n
    }
  }

  static vault (creator, quoteMint, quoteTokenProgram) {
    quoteMint = new PublicKey(quoteMint || NATIVE_MINT)
    quoteTokenProgram = new PublicKey(quoteTokenProgram || TOKEN_PROGRAM_ID)

    const creatorVaultAutority = getCreatorVaultAuthority(creator)
    const coinCreatorVaultAta = getCoinCreatorVaultAta(creatorVaultAutority, quoteTokenProgram, quoteMint)

    return coinCreatorVaultAta.toString()
  }

  async ready () {
    if (this.opening) return this.opening

    await this.fetchGlobalConfigAccount()
    await this.fetchFeeConfigAccount()
  }

  async fetchGlobalConfigAccount () {
    const globalConfigAddress = globalConfigPda(PUMP_AMM_PROGRAM_ID)[0]
    const accountInfo = await this.rpc.getAccountInfo(globalConfigAddress)

    if (!accountInfo) {
      throw new Error('Global config not found')
    }

    const data = padTrailing(toBuffer(accountInfo.data), GLOBAL_CONFIG_ACCOUNT_SIZE)
    const pool = this.borsh.amm.decode(data, ['accounts', 'GlobalConfig'])

    this.global = pool

    return pool
  }

  async fetchFeeConfigAccount () {
    const accountInfo = await this.rpc.getAccountInfo(getFeeConfig())

    if (!accountInfo) {
      return null
    }

    const feeConfig = decodeFeeConfig(accountInfo.data)

    this.feeConfig = feeConfig

    return feeConfig
  }

  // Compat, remove later
  async fetchPool (poolAddress) {
    return this.getPool(poolAddress)
  }

  async getPool (poolAddress) {
    const accountInfo = await this.rpc.getAccountInfo(new PublicKey(poolAddress))

    if (!accountInfo) {
      throw new Error('Pool account not found')
    }

    const data = padTrailing(toBuffer(accountInfo.data), POOL_ACCOUNT_SIZE)
    const pool = this.borsh.amm.decode(data, ['accounts', 'Pool'])

    return pool
  }

  async _getPoolCached (poolAddress) {
    poolAddress = new PublicKey(poolAddress).toBase58()

    const cachedPool = pools.get(poolAddress)

    const accountInfo = await this.rpc.getAccountInfo(new PublicKey(poolAddress))

    if (!accountInfo) {
      throw new Error('Pool account not found')
    }

    const data = toBuffer(accountInfo.data)
    const pool = this.borsh.amm.decode(padTrailing(data, POOL_ACCOUNT_SIZE), ['accounts', 'Pool'])

    if (cachedPool) {
      cachedPool.pool = pool
      cachedPool.dataLength = data.length

      return cachedPool
    }

    const result = {
      pool,
      dataLength: data.length
    }

    pools.set(poolAddress, result)

    // TODO: Keep only the creator and increase cache size
    if (pools.size >= 1000) {
      const oldestKey = pools.keys().next().value

      if (oldestKey) {
        pools.delete(oldestKey)
      }
    }

    return result
  }

  async getTokenAccount (address, programId) {
    const accountInfo = await this.rpc.getAccountInfo(new PublicKey(address))

    if (!accountInfo) {
      throw new Error('Token account not found')
    }

    // The fixed token-account prefix is shared by SPL Token and Token-2022 accounts.
    const account = this.borsh.token.decode(accountInfo.data, ['accounts', 'Account'])
    account.tokenProgram = new PublicKey(accountInfo.owner || programId || TOKEN_PROGRAM_ID)

    return account
  }

  async getMint (address) {
    const accountInfo = await this.rpc.getAccountInfo(new PublicKey(address))

    if (!accountInfo) {
      throw new Error('Token account not found')
    }

    const account = this.borsh.token.decode(accountInfo.data, ['accounts', 'Mint'])
    account.tokenProgram = new PublicKey(accountInfo.owner || TOKEN_PROGRAM_ID)

    return account
  }

  async getReserves (baseMint, quoteMint) {
    await this.ready()

    baseMint = new PublicKey(baseMint)
    quoteMint = new PublicKey(quoteMint || NATIVE_MINT)

    const poolAddress = Pumpswap.poolAddress(baseMint, quoteMint)
    const poolRecord = await this._getPoolCached(poolAddress)
    const pool = poolRecord.pool

    baseMint = new PublicKey(pool.base_mint)
    quoteMint = new PublicKey(pool.quote_mint)

    // TODO: Handle mint decimals

    const poolBaseTokenAccount = new PublicKey(pool.pool_base_token_account)
    const poolQuoteTokenAccount = new PublicKey(pool.pool_quote_token_account)

    const [mint, poolBase, poolQuote] = await Promise.all([
      this.getMint(baseMint),
      this.getTokenAccount(poolBaseTokenAccount),
      this.getTokenAccount(poolQuoteTokenAccount)
    ])

    return {
      baseReserve: poolBase.amount,
      quoteReserve: poolQuote.amount,
      creator: pool.coin_creator,
      coinCreator: pool.coin_creator,
      poolCreator: pool.creator,
      baseMint,
      quoteMint,
      baseTokenProgram: poolBase.tokenProgram || mint.tokenProgram || TOKEN_PROGRAM_ID,
      quoteTokenProgram: poolQuote.tokenProgram || TOKEN_PROGRAM_ID,
      tokenTotalSupply: mint.supply,
      isMayhemMode: pool.is_mayhem_mode || false,
      isCashbackCoin: pool.is_cashback_coin || false,
      virtualQuoteReserves: pool.virtual_quote_reserves || 0n,
      creatorFeeBps: pool.creator_fee_bps || 0n,
      canEditCreatorFee: pool.can_edit_creator_fee || false,
      poolAddress,
      poolBaseTokenAccount,
      poolQuoteTokenAccount,
      poolAccountDataLength: poolRecord.dataLength,
      global: this.global,
      feeConfig: this.feeConfig
    }
  }

  quoteToBase (quoteAmountIn, reserves, slippage, opts = {}) {
    if (!this.global) throw new Error('GlobalConfig is required')

    quoteAmountIn = normalizeQuoteAmount(quoteAmountIn)

    if (quoteAmountIn <= 0n) {
      return {
        baseAmountOut: 0n,
        quoteAmountIn: 0n,
        quoteAmountInWithLpFee: 0n,
        userQuoteAmountIn: 0n,
        quoteInMax: 0n
      }
    }

    const fees = getFees(this.global, this.feeConfig, reserves)
    const coinCreator = reserves.coinCreator || reserves.creator || PublicKey.default
    const lpFee = fee(quoteAmountIn, fees.lp_fee_bps)
    const protocolFee = fee(quoteAmountIn, fees.protocol_fee_bps)
    const coinCreatorFee = PublicKey.default.equals(coinCreator) ? 0n : fee(quoteAmountIn, fees.creator_fee_bps)

    const userQuoteAmountIn = quoteAmountIn + lpFee + protocolFee + coinCreatorFee
    const quoteAmountInWithLpFee = quoteAmountIn + lpFee

    const quoteInMax = calculateSlippage(userQuoteAmountIn, normalizeSlippage(slippage || 0n))

    const quoteReserve = effectiveQuoteReserve(reserves)
    const numerator = reserves.baseReserve * quoteAmountIn
    const denominator = quoteReserve + quoteAmountIn

    if (denominator === 0n) {
      throw new Error('Pool would be depleted, denominator is zero')
    }

    const baseAmountOut = numerator / denominator

    const swap = {
      baseAmountOut,
      quoteAmountIn,
      quoteAmountInWithLpFee,
      userQuoteAmountIn,
      quoteInMax
    }

    if (opts.sync) {
      this.sync(swap, reserves)
    }

    return swap
  }

  baseToQuoteIn (baseAmountOut, reserves, slippage, opts = {}) {
    if (!this.global) throw new Error('GlobalConfig is required')

    baseAmountOut = normalizeBaseAmount(baseAmountOut)

    if (baseAmountOut <= 0n) {
      return {
        baseAmountOut: 0n,
        quoteAmountIn: 0n,
        quoteAmountInWithLpFee: 0n,
        userQuoteAmountIn: 0n,
        quoteInMax: 0n
      }
    }

    if (baseAmountOut > reserves.baseReserve) {
      throw new Error('Cannot buy more base tokens than the pool reserves')
    }

    const quoteReserve = effectiveQuoteReserve(reserves)
    const numerator = quoteReserve * baseAmountOut
    const denominator = reserves.baseReserve - baseAmountOut

    if (denominator === 0n) {
      throw new Error('Pool would be depleted, denominator is zero')
    }

    const quoteAmountIn = ceilDiv(numerator, denominator)

    const fees = getFees(this.global, this.feeConfig, reserves)
    const coinCreator = reserves.coinCreator || reserves.creator || PublicKey.default
    const lpFee = fee(quoteAmountIn, fees.lp_fee_bps)
    const protocolFee = fee(quoteAmountIn, fees.protocol_fee_bps)
    const coinCreatorFee = PublicKey.default.equals(coinCreator) ? 0n : fee(quoteAmountIn, fees.creator_fee_bps)

    const userQuoteAmountIn = quoteAmountIn + lpFee + protocolFee + coinCreatorFee
    const quoteAmountInWithLpFee = quoteAmountIn + lpFee

    const quoteInMax = calculateSlippage(userQuoteAmountIn, normalizeSlippage(slippage || 0n))

    const swap = {
      baseAmountOut,
      quoteAmountIn,
      quoteAmountInWithLpFee,
      userQuoteAmountIn,
      quoteInMax
    }

    if (opts.sync) {
      this.sync(swap, reserves)
    }

    return swap
  }

  baseToQuote (baseAmountIn, reserves, slippage, opts = {}) {
    if (!this.global) throw new Error('GlobalConfig is required')

    baseAmountIn = normalizeBaseAmount(baseAmountIn)

    if (baseAmountIn <= 0n) {
      return {
        baseAmountIn: 0n,
        quoteAmountOut: 0n,
        quoteAmountOutWithoutLpFee: 0n,
        userQuoteAmountOut: 0n,
        quoteOutMin: 0n
      }
    }

    if (reserves.baseReserve === 0n || reserves.quoteReserve === 0n) {
      throw new Error('Invalid input: reserves cannot be zero')
    }

    const quoteReserve = effectiveQuoteReserve(reserves)
    const numerator = quoteReserve * baseAmountIn
    const denominator = reserves.baseReserve + baseAmountIn

    const quoteAmountOut = denominator === 0n ? 0n : numerator / denominator

    const fees = getFees(this.global, this.feeConfig, reserves)
    const coinCreator = reserves.coinCreator || reserves.creator || PublicKey.default
    const lpFee = fee(quoteAmountOut, fees.lp_fee_bps)
    const protocolFee = fee(quoteAmountOut, fees.protocol_fee_bps)
    const coinCreatorFee = PublicKey.default.equals(coinCreator) ? 0n : fee(quoteAmountOut, fees.creator_fee_bps)

    const userQuoteAmountOut = quoteAmountOut - lpFee - protocolFee - coinCreatorFee
    const quoteAmountOutWithoutLpFee = quoteAmountOut - lpFee

    const quoteOutMin = calculateSlippage(userQuoteAmountOut, (normalizeSlippage(slippage || 0n)) * -1n)

    const swap = {
      baseAmountIn,
      quoteAmountOut,
      quoteAmountOutWithoutLpFee,
      userQuoteAmountOut,
      quoteOutMin
    }

    if (opts.sync) {
      this.sync(swap, reserves)
    }

    return swap
  }

  getQuoteInMax (quoteAmountIn, slippage) {
    quoteAmountIn = normalizeQuoteAmount(quoteAmountIn)

    const quoteInMax = calculateSlippage(quoteAmountIn, normalizeSlippage(slippage || 0n))

    return quoteInMax
  }

  getQuoteOutMin (quoteAmountOut, slippage) {
    quoteAmountOut = normalizeQuoteAmount(quoteAmountOut)

    const quoteOutMin = calculateSlippage(quoteAmountOut, normalizeSlippage(slippage || 0n) * -1n)

    return quoteOutMin
  }

  sync (swap, reserves) {
    return Pumpswap.sync(swap, reserves)
  }

  unsync (swap, reserves) {
    return Pumpswap.unsync(swap, reserves)
  }

  static sync (swap, reserves) {
    if (!swap.baseAmountOut && !swap.baseAmountIn) throw new Error('Required baseAmountOut or baseAmountIn')
    if (swap.baseAmountOut && swap.baseAmountIn) throw new Error('Cannot pass two swaps in one')

    // Buy (SOL -> TOKEN)
    if (swap.baseAmountOut) {
      reserves.baseReserve -= swap.baseAmountOut
      reserves.quoteReserve += swap.quoteAmountInWithLpFee
    }

    // Sell (TOKEN -> SOL)
    if (swap.baseAmountIn) {
      reserves.baseReserve += swap.baseAmountIn
      reserves.quoteReserve -= swap.quoteAmountOutWithoutLpFee
    }
  }

  static unsync (swap, reserves) {
    if (!swap.baseAmountOut && !swap.baseAmountIn) throw new Error('Required baseAmountOut or baseAmountIn')
    if (swap.baseAmountOut && swap.baseAmountIn) throw new Error('Cannot pass two swaps in one')

    // Buy (SOL -> TOKEN)
    if (swap.baseAmountOut) {
      reserves.baseReserve += swap.baseAmountOut
      reserves.quoteReserve -= swap.quoteAmountInWithLpFee
    }

    // Sell (TOKEN -> SOL)
    if (swap.baseAmountIn) {
      reserves.baseReserve -= swap.baseAmountIn
      reserves.quoteReserve += swap.quoteAmountOutWithoutLpFee
    }
  }

  keys (pool, baseMint, quoteMint, user, reserves) {
    const protocolFeeRecipient = getFeeRecipient(this.global, reserves.isMayhemMode)
    const baseTokenProgram = reserves.baseTokenProgram || TOKEN_PROGRAM_ID
    const quoteTokenProgram = reserves.quoteTokenProgram || TOKEN_PROGRAM_ID
    const protocolfeeRecipientTokenAccount = getProtocolFeeRecipientTokenAccount({ protocolFeeRecipient, quoteTokenProgram, quoteMint })

    const userBaseTokenAccount = TokenProgram.getAssociatedTokenAddressSync(new PublicKey(baseMint), new PublicKey(user), true, baseTokenProgram)
    const userQuoteTokenAccount = TokenProgram.getAssociatedTokenAddressSync(new PublicKey(quoteMint), new PublicKey(user), true, quoteTokenProgram)

    const globalConfigAddress = globalConfigPda(PUMP_AMM_PROGRAM_ID)[0]

    const coinCreator = reserves.coinCreator || reserves.creator || PublicKey.default
    const creatorVaultAutority = getCreatorVaultAuthority(coinCreator)
    const creatorVaultAccount = getCreatorVaultAccount(quoteMint, creatorVaultAutority, quoteTokenProgram)

    const globalVolumeAccumulator = globalVolumeAccumulatorPda()
    const userVolumeAccumulator = userVolumeAccumulatorPda(new PublicKey(user))
    const buybackFeeRecipient = getBuybackFeeRecipient(this.global)

    return {
      pool,
      globalConfig: globalConfigAddress,
      user,
      baseMint: new PublicKey(baseMint),
      quoteMint: new PublicKey(quoteMint),
      userBaseTokenAccount,
      userQuoteTokenAccount,
      poolBaseTokenAccount: reserves.poolBaseTokenAccount || TokenProgram.getAssociatedTokenAddressSync(new PublicKey(baseMint), new PublicKey(pool), true, baseTokenProgram),
      poolQuoteTokenAccount: reserves.poolQuoteTokenAccount || TokenProgram.getAssociatedTokenAddressSync(new PublicKey(quoteMint), new PublicKey(pool), true, quoteTokenProgram),
      protocolFeeRecipient: new PublicKey(protocolFeeRecipient),
      protocolFeeRecipientTokenAccount: new PublicKey(protocolfeeRecipientTokenAccount),
      baseTokenProgram: new PublicKey(baseTokenProgram),
      quoteTokenProgram: new PublicKey(quoteTokenProgram),
      creatorVaultAutority,
      creatorVaultAccount,
      globalVolumeAccumulator,
      userVolumeAccumulator,
      buybackFeeRecipient: buybackFeeRecipient ? new PublicKey(buybackFeeRecipient) : null,
      buybackFeeRecipientTokenAccount: buybackFeeRecipient
        ? getAssociatedTokenAddress(quoteMint, buybackFeeRecipient, quoteTokenProgram)
        : null
    }
  }

  buy (mint, baseAmountOut, quoteInMax, user, reserves) {
    return this.buyExactOut(mint, NATIVE_MINT, baseAmountOut, quoteInMax, user, reserves)
  }

  sell (mint, baseAmountIn, quoteOutMin, user, reserves) {
    return this.sellExactIn(mint, NATIVE_MINT, baseAmountIn, quoteOutMin, user, reserves)
  }

  // Compat, remove later
  buyExactTokensForSOL (baseMint, quoteMint, baseAmountOut, quoteInMax, user, reserves) {
    return this.buyExactOut(baseMint, quoteMint, baseAmountOut, quoteInMax, user, reserves)
  }

  sellExactTokensForSOL (baseMint, quoteMint, baseAmountOut, quoteInMax, user, reserves) {
    return this.sellExactIn(baseMint, quoteMint, baseAmountOut, quoteInMax, user, reserves)
  }

  buyExactOut (baseMint, quoteMint, baseAmountOut, quoteInMax, user, reserves) {
    baseMint = new PublicKey(baseMint)
    quoteMint = new PublicKey(quoteMint)
    user = new PublicKey(user)

    baseAmountOut = normalizeBaseAmount(baseAmountOut)
    quoteInMax = normalizeQuoteAmount(quoteInMax)

    const poolAddress = Pumpswap.poolAddress(baseMint, quoteMint)
    const keys = this.keys(poolAddress, baseMint, quoteMint, user, reserves)

    const instructions = []

    if (shouldExtendPool(reserves)) instructions.push(this.extendAccount(poolAddress, user))

    // TODO: Kind of assuming everywhere that "base" is TOKEN and "quote" is SOL
    // TODO: Double check this part due similar handling of base vs quote accounts
    const ixAccountBase = this.createAccount(user, baseMint, keys.userBaseTokenAccount, keys.baseTokenProgram)
    const ixAccountQuote = this.createWsolAccount(user, quoteMint, keys.userQuoteTokenAccount, quoteInMax, keys.quoteTokenProgram)

    if (ixAccountBase) instructions.push(...ixAccountBase)
    if (ixAccountQuote) instructions.push(...ixAccountQuote)

    // Optional hook for external encoding
    let data = !this._encode ? null : this._encode('buy', { baseOut: baseAmountOut, quoteInMax, trackVolume: true })

    if (!data) {
      // TODO: Use like: this.borsh.amm.idl.instructions.find(ix => ix.name === 'buy')
      data = Buffer.concat([
        Borsh.discriminator('global', 'buy'),
        bigintToU64LE(baseAmountOut),
        bigintToU64LE(quoteInMax),
        Buffer.from([1])
      ])
    }

    instructions.push(new TransactionInstruction({
      programId: this.programId,

      // TODO: Use the IDL to create the keys based on "instructions->accounts"
      keys: [
        { pubkey: keys.pool, isSigner: false, isWritable: true },
        { pubkey: keys.user, isSigner: true, isWritable: true },
        { pubkey: keys.globalConfig, isSigner: false, isWritable: false },
        { pubkey: keys.baseMint, isSigner: false, isWritable: false },
        { pubkey: keys.quoteMint, isSigner: false, isWritable: false },
        { pubkey: keys.userBaseTokenAccount, isSigner: false, isWritable: true },
        { pubkey: keys.userQuoteTokenAccount, isSigner: false, isWritable: true },
        { pubkey: keys.poolBaseTokenAccount, isSigner: false, isWritable: true },
        { pubkey: keys.poolQuoteTokenAccount, isSigner: false, isWritable: true },
        { pubkey: keys.protocolFeeRecipient, isSigner: false, isWritable: false },
        { pubkey: keys.protocolFeeRecipientTokenAccount, isSigner: false, isWritable: true },
        { pubkey: keys.baseTokenProgram, isSigner: false, isWritable: false },
        { pubkey: keys.quoteTokenProgram, isSigner: false, isWritable: false },

        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: eventAuthorityPda(this.programId), isSigner: false, isWritable: false },
        { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false },

        { pubkey: keys.creatorVaultAccount, isSigner: false, isWritable: true },
        { pubkey: keys.creatorVaultAutority, isSigner: false, isWritable: false },

        { pubkey: keys.globalVolumeAccumulator, isSigner: false, isWritable: true },
        { pubkey: keys.userVolumeAccumulator, isSigner: false, isWritable: true },

        { pubkey: getFeeConfig(), isSigner: false, isWritable: false },
        { pubkey: PUMP_FEE_PROGRAM_ID, isSigner: false, isWritable: false },
        ...getSwapRemainingAccounts({ keys, reserves, buy: true })
      ],
      data
    }))

    if (new PublicKey(baseMint).equals(NATIVE_MINT)) instructions.push(...this.closeAccount(user, keys.userBaseTokenAccount, keys.baseTokenProgram))
    if (ixAccountQuote) instructions.push(...this.closeAccount(user, keys.userQuoteTokenAccount, keys.quoteTokenProgram))

    return instructions
  }

  sellExactIn (baseMint, quoteMint, baseAmountIn, quoteOutMin, user, reserves) {
    baseMint = new PublicKey(baseMint)
    quoteMint = new PublicKey(quoteMint)
    user = new PublicKey(user)

    baseAmountIn = normalizeBaseAmount(baseAmountIn)
    quoteOutMin = normalizeQuoteAmount(quoteOutMin)

    const poolAddress = Pumpswap.poolAddress(baseMint, quoteMint)
    const keys = this.keys(poolAddress, baseMint, quoteMint, user, reserves)

    const instructions = []

    if (shouldExtendPool(reserves)) instructions.push(this.extendAccount(poolAddress, user))

    const ixAccountBase = this.createWsolAccount(user, baseMint, keys.userBaseTokenAccount, baseAmountIn, keys.baseTokenProgram)
    const ixAccountQuote = this.createAccount(user, quoteMint, keys.userQuoteTokenAccount, keys.quoteTokenProgram)

    if (ixAccountBase) instructions.push(...ixAccountBase)
    if (ixAccountQuote) instructions.push(...ixAccountQuote)

    const data = Buffer.concat([
      Borsh.discriminator('global', 'sell'),
      bigintToU64LE(baseAmountIn),
      bigintToU64LE(quoteOutMin)
    ])

    instructions.push(new TransactionInstruction({
      programId: this.programId,
      // TODO: Use the IDL to create the keys based on "instructions->accounts"
      keys: [
        { pubkey: keys.pool, isSigner: false, isWritable: true },
        { pubkey: keys.user, isSigner: true, isWritable: true },
        { pubkey: keys.globalConfig, isSigner: false, isWritable: false },
        { pubkey: keys.baseMint, isSigner: false, isWritable: false },
        { pubkey: keys.quoteMint, isSigner: false, isWritable: false },
        { pubkey: keys.userBaseTokenAccount, isSigner: false, isWritable: true },
        { pubkey: keys.userQuoteTokenAccount, isSigner: false, isWritable: true },
        { pubkey: keys.poolBaseTokenAccount, isSigner: false, isWritable: true },
        { pubkey: keys.poolQuoteTokenAccount, isSigner: false, isWritable: true },
        { pubkey: keys.protocolFeeRecipient, isSigner: false, isWritable: false },
        { pubkey: keys.protocolFeeRecipientTokenAccount, isSigner: false, isWritable: true },
        { pubkey: keys.baseTokenProgram, isSigner: false, isWritable: false },
        { pubkey: keys.quoteTokenProgram, isSigner: false, isWritable: false },

        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: eventAuthorityPda(this.programId), isSigner: false, isWritable: false },
        { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false },

        { pubkey: keys.creatorVaultAccount, isSigner: false, isWritable: true },
        { pubkey: keys.creatorVaultAutority, isSigner: false, isWritable: false },

        { pubkey: getFeeConfig(), isSigner: false, isWritable: false },
        { pubkey: PUMP_FEE_PROGRAM_ID, isSigner: false, isWritable: false },
        ...getSwapRemainingAccounts({ keys, reserves, buy: false })
      ],
      data
    }))

    if (ixAccountBase) instructions.push(...this.closeAccount(user, keys.userBaseTokenAccount, keys.baseTokenProgram))
    if (new PublicKey(quoteMint).equals(NATIVE_MINT)) instructions.push(...this.closeAccount(user, keys.userQuoteTokenAccount, keys.quoteTokenProgram))

    return instructions
  }

  extendAccount (pool, user) {
    const data = Borsh.discriminator('global', 'extend_account')

    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: pool, isSigner: false, isWritable: true },
        { pubkey: user, isSigner: true, isWritable: false },
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: eventAuthorityPda(this.programId), isSigner: false, isWritable: false },
        { pubkey: this.programId, isSigner: false, isWritable: false }
      ],
      data
    })
  }

  collect (creator, quoteMint, quoteTokenProgram) {
    creator = new PublicKey(creator)
    quoteMint = new PublicKey(quoteMint || NATIVE_MINT)
    quoteTokenProgram = new PublicKey(quoteTokenProgram || TOKEN_PROGRAM_ID)

    const creatorVaultAutority = getCreatorVaultAuthority(creator)
    const coinCreatorVaultAta = getCoinCreatorVaultAta(creatorVaultAutority, quoteTokenProgram, quoteMint)
    const coinCreatorTokenAccount = TokenProgram.getAssociatedTokenAddressSync(quoteMint, creator, true, quoteTokenProgram)

    const keys = [
      { pubkey: quoteMint, isSigner: false, isWritable: false },
      { pubkey: quoteTokenProgram, isSigner: false, isWritable: false },
      { pubkey: creator, isSigner: false, isWritable: false },
      { pubkey: creatorVaultAutority, isSigner: false, isWritable: false },
      { pubkey: coinCreatorVaultAta, isSigner: false, isWritable: true },
      { pubkey: coinCreatorTokenAccount, isSigner: false, isWritable: true },
      { pubkey: eventAuthorityPda(this.programId), isSigner: false, isWritable: false },
      { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false }
    ]

    const instructions = []

    instructions.push(TokenProgram.createAssociatedTokenAccountIdempotentInstruction(creator, coinCreatorVaultAta, creatorVaultAutority, quoteMint, quoteTokenProgram))
    instructions.push(TokenProgram.createAssociatedTokenAccountIdempotentInstruction(creator, coinCreatorTokenAccount, creator, quoteMint, quoteTokenProgram))

    const data = Borsh.discriminator('global', 'collect_coin_creator_fee')

    instructions.push(new TransactionInstruction({
      programId: this.programId,
      keys,
      data
    }))

    return instructions
  }

  createAccount (user, mint, ata, programId) {
    const instructions = []

    instructions.push(
      TokenProgram.createAssociatedTokenAccountIdempotentInstruction(user, ata, user, mint, programId || TOKEN_PROGRAM_ID)
    )

    return instructions
  }

  createWsolAccount (user, mint, ata, amount, programId) {
    if (new PublicKey(mint).equals(NATIVE_MINT)) {
      const instructions = []

      instructions.push(
        TokenProgram.createAssociatedTokenAccountIdempotentInstruction(user, ata, user, mint, programId || TOKEN_PROGRAM_ID)
      )

      if (amount) {
        instructions.push(
          SystemProgram.transfer({
            fromPubkey: user,
            toPubkey: ata,
            lamports: BigInt(amount.toString())
          }),
          TokenProgram.createSyncNativeInstruction(ata, programId || TOKEN_PROGRAM_ID)
        )
      }

      return instructions
    }

    return null
  }

  closeAccount (user, ata, programId) {
    const instructions = []

    instructions.push(
      TokenProgram.createCloseAccountInstruction(
        ata,
        user,
        user,
        undefined,
        programId || TOKEN_PROGRAM_ID
      )
    )

    return instructions
  }

  async getCoinCreatorVaultBalance (creator, quoteMint) {
    quoteMint = new PublicKey(quoteMint || NATIVE_MINT)
    const mint = await this.getMint(quoteMint)
    const quoteTokenProgram = mint.tokenProgram || TOKEN_PROGRAM_ID

    const creatorVaultAutority = getCreatorVaultAuthority(creator)
    const coinCreatorVaultAta = getCoinCreatorVaultAta(creatorVaultAutority, quoteTokenProgram, quoteMint)

    try {
      const tokenAccount = await this.getTokenAccount(coinCreatorVaultAta)

      return tokenAccount.amount
    } catch (err) {
      if (err.message === 'Token account not found') {
        return 0n
      }

      throw err
    }
  }
}

function pumpPoolAuthorityPda (mint, pumpProgramId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool-authority'), new PublicKey(mint).toBuffer()],
    pumpProgramId || PUMP_PROGRAM_ID
  )
}

function poolPda (index, creator, baseMint, quoteMint, programId) {
  const indexBuf = Buffer.alloc(2)
  indexBuf.writeUInt16LE(index)

  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), indexBuf, new PublicKey(creator).toBuffer(), new PublicKey(baseMint).toBuffer(), new PublicKey(quoteMint).toBuffer()],
    programId || PUMP_AMM_PROGRAM_ID
  )
}
function canonicalPumpPoolPda (mint, quoteMint, programId, pumpProgramId) {
  const [authority] = pumpPoolAuthorityPda(mint, pumpProgramId || PUMP_PROGRAM_ID)
  quoteMint = canonicalPoolQuoteMint(quoteMint)

  return poolPda(0, authority, mint, quoteMint, programId || PUMP_AMM_PROGRAM_ID)
}

function canonicalPoolQuoteMint (quoteMint) {
  quoteMint = new PublicKey(quoteMint || NATIVE_MINT)

  return quoteMint.equals(PublicKey.default) ? NATIVE_MINT : quoteMint
}

function globalConfigPda (programId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('global_config')],
    programId || PUMP_AMM_PROGRAM_ID
  )
}

function getCreatorVaultAuthority (creator) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('creator_vault'),
      new PublicKey(creator).toBuffer()
    ],
    PUMP_AMM_PROGRAM_ID
  )[0]
}

function getCreatorVaultAccount (quoteMint, vaultAutority, quoteTokenProgram) {
  return TokenProgram.getAssociatedTokenAddressSync(quoteMint, vaultAutority, true, quoteTokenProgram || TOKEN_PROGRAM_ID)
}

function globalVolumeAccumulatorPda () {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('global_volume_accumulator')],
    PUMP_AMM_PROGRAM_ID
  )[0]
}

function userVolumeAccumulatorPda (user) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('user_volume_accumulator'), new PublicKey(user).toBuffer()],
    PUMP_AMM_PROGRAM_ID
  )[0]
}

function getFeeConfig () {
  const [pda] = PublicKey.findProgramAddressSync([
    Buffer.from('fee_config'),
    Buffer.from([12, 20, 222, 252, 130, 94, 198, 118, 148, 37, 8, 24, 187, 101, 64, 101, 244, 41, 141, 49, 86, 213, 113, 180, 212, 248, 9, 12, 24, 233, 168, 99])
  ], PUMP_FEE_PROGRAM_ID)

  return pda
}

function decodeFeeConfig (data) {
  data = toBuffer(data)

  const discriminator = Borsh.discriminator('account', 'FeeConfig')

  if (!data.subarray(0, discriminator.length).equals(discriminator)) {
    throw new Error('Discriminator mismatch')
  }

  if (data.length < FEE_CONFIG_SIZE_PRE_STABLE) {
    throw new Error('FeeConfig account is shorter than the pre-stable layout')
  }

  let offset = discriminator.length
  const bump = data.readUInt8(offset)
  offset += 1

  const admin = new PublicKey(data.subarray(offset, offset + 32)).toBase58()
  offset += 32

  const [flatFees, flatFeesOffset] = decodeFees(data, offset)
  offset = flatFeesOffset

  const [feeTiers, feeTiersOffset] = decodeFeeTiers(data, offset)
  offset = feeTiersOffset

  let stableFeeTiers = []
  let exoticFlatFees = zeroFees()

  if (data.length >= FEE_CONFIG_SIZE_POST_STABLE) {
    const decoded = decodeFeeTiers(data, offset)
    stableFeeTiers = decoded[0]
    offset = decoded[1]
  }

  if (data.length >= FEE_CONFIG_SIZE_POST_EXOTIC) {
    const decoded = decodeFees(data, offset)
    exoticFlatFees = decoded[0]
    offset = decoded[1]
  }

  return {
    bump,
    admin,
    flat_fees: flatFees,
    fee_tiers: feeTiers,
    stable_fee_tiers: stableFeeTiers,
    exotic_flat_fees: exoticFlatFees
  }
}

function decodeFeeTiers (data, offset) {
  if (offset + 4 > data.length) {
    throw new Error('FeeConfig fee tier vector length runs past the account data')
  }

  const feeTiersLength = data.readUInt32LE(offset)
  offset += 4
  const feeTiers = []

  if (offset + feeTiersLength * 40 > data.length) {
    throw new Error('FeeConfig fee tier vector runs past the account data')
  }

  for (let i = 0; i < feeTiersLength; i++) {
    const marketCapLamportsThreshold = readU128LE(data, offset)
    offset += 16

    const [fees, feesOffset] = decodeFees(data, offset)
    offset = feesOffset

    feeTiers.push({ market_cap_lamports_threshold: marketCapLamportsThreshold, fees })
  }

  return [feeTiers, offset]
}

function decodeFees (data, offset) {
  const lpFeeBps = data.readBigUInt64LE(offset)
  const protocolFeeBps = data.readBigUInt64LE(offset + 8)
  const creatorFeeBps = data.readBigUInt64LE(offset + 16)

  return [
    { lp_fee_bps: lpFeeBps, protocol_fee_bps: protocolFeeBps, creator_fee_bps: creatorFeeBps },
    offset + 24
  ]
}

function readU128LE (data, offset) {
  const low = data.readBigUInt64LE(offset)
  const high = data.readBigUInt64LE(offset + 8)

  return (high << 64n) + low
}

function toBuffer (data) {
  if (Array.isArray(data)) return Buffer.from(data[0], data[1] || 'base64')
  if (typeof data === 'string') return Buffer.from(data, 'base64')
  return Buffer.from(data)
}

function padTrailing (data, size) {
  return data.length >= size ? data : Buffer.concat([data, Buffer.alloc(size - data.length)])
}

function zeroFees () {
  return { lp_fee_bps: 0n, protocol_fee_bps: 0n, creator_fee_bps: 0n }
}

function getFees (global, feeConfig, reserves) {
  const config = reserves.global || global
  const currentFeeConfig = reserves.feeConfig || feeConfig

  if (!config) throw new Error('GlobalConfig is required')

  const fallback = {
    lp_fee_bps: config.lp_fee_basis_points,
    protocol_fee_bps: config.protocol_fee_basis_points,
    creator_fee_bps: config.coin_creator_fee_basis_points || 0n
  }

  if (!currentFeeConfig || !reserves.baseMint || !reserves.poolCreator) return fallback

  const tokenTotalSupply = reserves.isMayhemMode
    ? 1_000_000_000_000_000n
    : (reserves.tokenTotalSupply || 1_000_000_000_000_000n)
  const quoteReserve = effectiveQuoteReserve(reserves)
  const marketCap = reserves.baseReserve === 0n
    ? 0n
    : (tokenTotalSupply * quoteReserve) / reserves.baseReserve
  const quoteMint = new PublicKey(reserves.quoteMint || NATIVE_MINT)
  const fees = isCanonicalPool(reserves.baseMint, reserves.poolCreator)
    ? getCanonicalFees(currentFeeConfig, quoteMint, marketCap)
    : currentFeeConfig.flat_fees

  if (!fees) return fallback

  if (config.creator_fee_configurable && reserves.creatorFeeBps > 0n) {
    return { ...fees, creator_fee_bps: reserves.creatorFeeBps }
  }

  return fees
}

function getCanonicalFees (feeConfig, quoteMint, marketCap) {
  if (isSolLikeQuoteMint(quoteMint)) {
    return calculateFeeTier(feeConfig.fee_tiers, marketCap)
  }

  if (quoteMint.equals(USDC_MINT)) {
    return calculateFeeTier(
      feeConfig.stable_fee_tiers && feeConfig.stable_fee_tiers.length > 0
        ? feeConfig.stable_fee_tiers
        : feeConfig.fee_tiers,
      marketCap
    )
  }

  return isZeroFees(feeConfig.exotic_flat_fees)
    ? feeConfig.flat_fees
    : feeConfig.exotic_flat_fees
}

function isSolLikeQuoteMint (quoteMint) {
  return quoteMint.equals(PublicKey.default) || quoteMint.equals(NATIVE_MINT) || quoteMint.equals(NATIVE_MINT_2022)
}

function isZeroFees (fees) {
  return !fees || (fees.lp_fee_bps === 0n && fees.protocol_fee_bps === 0n && fees.creator_fee_bps === 0n)
}

function calculateFeeTier (feeTiers, marketCap) {
  if (!feeTiers || feeTiers.length === 0) return null

  const firstTier = feeTiers[0]

  if (marketCap < firstTier.market_cap_lamports_threshold) {
    return firstTier.fees
  }

  for (let i = feeTiers.length - 1; i >= 0; i--) {
    const tier = feeTiers[i]

    if (marketCap >= tier.market_cap_lamports_threshold) {
      return tier.fees
    }
  }

  return firstTier.fees
}

function effectiveQuoteReserve (reserves) {
  return reserves.quoteReserve + (reserves.virtualQuoteReserves || 0n)
}

function isCanonicalPool (baseMint, poolCreator) {
  if (!baseMint || !poolCreator) return false

  const [authority] = pumpPoolAuthorityPda(baseMint)

  return authority.equals(poolCreator)
}

function shouldExtendPool (reserves) {
  return typeof reserves.poolAccountDataLength === 'undefined' || reserves.poolAccountDataLength < POOL_ACCOUNT_NEW_SIZE
}

function eventAuthorityPda (programId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    programId || PUMP_AMM_PROGRAM_ID
  )[0]
}

function noop () {}

function getProtocolFeeRecipientTokenAccount ({ protocolFeeRecipient, quoteTokenProgram, quoteMint }) {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      new PublicKey(protocolFeeRecipient).toBuffer(),
      new PublicKey(quoteTokenProgram).toBuffer(),
      new PublicKey(quoteMint).toBuffer()
    ],
    PDA_PROGRAM_ID
  )

  return pda
}

function getAssociatedTokenAddress (mint, owner, programId) {
  return TokenProgram.getAssociatedTokenAddressSync(
    new PublicKey(mint),
    new PublicKey(owner),
    true,
    new PublicKey(programId)
  )
}

function getFeeRecipient (global, isMayhemMode) {
  const regularRecipients = global.protocol_fee_recipients || []
  const reservedRecipients = [
    global.reserved_fee_recipient,
    ...(global.reserved_fee_recipients || [])
  ]
  const recipients = isMayhemMode ? validKeys(reservedRecipients) : validKeys(regularRecipients)
  const fallback = validKeys(regularRecipients)
  const selected = recipients.length > 0 ? recipients : fallback

  return selected.length > 0
    ? selected[Math.floor(Math.random() * selected.length)]
    : PublicKey.default
}

function getBuybackFeeRecipient (global) {
  const recipients = validKeys(global.buyback_fee_recipients || [])

  return recipients.length > 0
    ? recipients[Math.floor(Math.random() * recipients.length)]
    : null
}

function validKeys (keys) {
  return keys.filter(key => key && !PublicKey.default.equals(key))
}

function getSwapRemainingAccounts ({ keys, reserves, buy }) {
  const accounts = []
  const coinCreator = reserves.coinCreator || reserves.creator || PublicKey.default

  if (reserves.isCashbackCoin) {
    accounts.push({
      pubkey: getAssociatedTokenAddress(keys.quoteMint, keys.userVolumeAccumulator, keys.quoteTokenProgram),
      isSigner: false,
      isWritable: true
    })

    if (!buy) {
      accounts.push({
        pubkey: keys.userVolumeAccumulator,
        isSigner: false,
        isWritable: true
      })
    }
  }

  if (!PublicKey.default.equals(coinCreator)) {
    accounts.push({
      pubkey: poolV2Pda(keys.baseMint),
      isSigner: false,
      isWritable: false
    })
  }

  if (keys.buybackFeeRecipient && keys.buybackFeeRecipientTokenAccount) {
    accounts.push(
      {
        pubkey: keys.buybackFeeRecipient,
        isSigner: false,
        isWritable: false
      },
      {
        pubkey: keys.buybackFeeRecipientTokenAccount,
        isSigner: false,
        isWritable: true
      }
    )
  }

  return accounts
}

function poolV2Pda (baseMint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool-v2'), new PublicKey(baseMint).toBuffer()],
    PUMP_AMM_PROGRAM_ID
  )[0]
}

function getCoinCreatorVaultAta (creatorVaultAutority, quoteTokenProgram, quoteMint) {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      new PublicKey(creatorVaultAutority).toBuffer(),
      new PublicKey(quoteTokenProgram).toBuffer(),
      new PublicKey(quoteMint).toBuffer()
    ],
    new PublicKey(Buffer.from([140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89]))
  )

  return pda
}

function bigintToU64LE (x) {
  if (x < 0n || x > 0xFFFFFFFFFFFFFFFFn) throw new Error('bigint out of u64 range')

  const buffer = Buffer.alloc(8)

  buffer.writeBigUInt64LE(x)

  return buffer
}

function ceilDiv (a, b) {
  if (b === 0n) throw new Error('Cannot divide by zero')
  return (a + b - 1n) / b
}

function fee (amount, basisPoints) {
  return ceilDiv(amount * basisPoints, 10_000n)
}

function normalizeSlippage (slippage) {
  if (typeof slippage === 'number') return BigInt(Math.floor(slippage * 10_000))
  if (typeof slippage !== 'bigint') slippage = BigInt(slippage)
  return slippage
}

function calculateSlippage (value, slippage) {
  const precision = 1_000_000_000n // 1e9
  const factor = (10_000n + (slippage || 0n)) * precision / 10_000n
  const max = (value * factor) / precision

  return max
}

function normalizeBaseAmount (baseAmountOut) {
  // Say base is TOKEN always (with 6 decimals)
  if (typeof baseAmountOut === 'number') baseAmountOut = BigInt((baseAmountOut * 1e6).toFixed(0))
  if (typeof baseAmountOut !== 'bigint') baseAmountOut = BigInt(baseAmountOut)
  return baseAmountOut
}

function normalizeQuoteAmount (quoteAmountIn) {
  // Say quote is SOL always (with 9 decimals)
  if (typeof quoteAmountIn === 'number') return BigInt((quoteAmountIn * 1e9).toFixed(0))
  if (typeof quoteAmountIn !== 'bigint') return BigInt(quoteAmountIn)
  return quoteAmountIn
}
