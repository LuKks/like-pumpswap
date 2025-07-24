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
// const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')

const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')
const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA')

const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const PDA_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')

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

    this.programId = opts.programId || PUMP_AMM_PROGRAM_ID

    this.opened = false
    this.opening = this.ready()
    this.opening.then(() => {
      this.opened = true
    })
    this.opening.catch(noop)
  }

  static PROGRAM_ID = PUMP_AMM_PROGRAM_ID
  static IDL = IDL_PUMP_AMM

  static poolAddress (mint) {
    return canonicalPumpPoolPda(new PublicKey(mint))[0]
  }

  static price (reserves) {
    if (reserves.baseReserve === 0n) {
      return 0n
    }

    return (reserves.quoteReserve * 1_000_000_000n) / reserves.baseReserve
  }

  static marketCap (reserves) {
    if (reserves.baseReserve === 0n) {
      return 0n
    }

    const tokenTotalSupply = reserves.tokenTotalSupply || 1_000_000_000_000_000n

    return (tokenTotalSupply * reserves.quoteReserve) / reserves.baseReserve
  }

  static global () {
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
      coin_creator_fee_basis_points: 5n
    }
  }

  async ready () {
    if (this.opening) return this.opening

    if (!this.global) {
      this.global = await this.fetchGlobalConfigAccount()
    }
  }

  async fetchGlobalConfigAccount () {
    if (this.global) {
      return this.global
    }

    const globalConfigAddress = globalConfigPda(PUMP_AMM_PROGRAM_ID)[0]
    const accountInfo = await this.rpc.getAccountInfo(globalConfigAddress)

    if (!accountInfo) {
      throw new Error('Global config not found')
    }

    const pool = this.borsh.amm.decode(accountInfo.data, ['accounts', 'GlobalConfig'])

    this.global = pool

    return pool
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

    const pool = this.borsh.amm.decode(accountInfo.data, ['accounts', 'Pool'])

    return pool
  }

  async _getPoolCached (poolAddress) {
    poolAddress = new PublicKey(poolAddress).toBase58()

    const pool = pools.get(poolAddress) || await this.getPool(poolAddress)

    pools.set(poolAddress, pool)

    // TODO: Keep only the creator and increase cache size
    if (pools.size >= 1000) {
      const oldestKey = pools.keys().next().value

      if (oldestKey) {
        pools.delete(oldestKey)
      }
    }

    return pool
  }

  async getTokenAccount (address, programId) {
    const accountInfo = await this.rpc.getAccountInfo(new PublicKey(address))

    if (!accountInfo) {
      throw new Error('Token account not found')
    }

    // TODO: Dynamic programId
    // Token Program: TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
    // Token 2022: TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb

    // TODO: "state: 1" enum is not being translated
    const account = this.borsh.token.decode(accountInfo.data, ['accounts', 'Account'])

    return account
  }

  async getMint (address) {
    const accountInfo = await this.rpc.getAccountInfo(new PublicKey(address))

    if (!accountInfo) {
      throw new Error('Token account not found')
    }

    const account = this.borsh.token.decode(accountInfo.data, ['accounts', 'Mint'])

    return account
  }

  async getReserves (baseMint, quoteMint) {
    const poolAddress = Pumpswap.poolAddress(baseMint)

    // TODO: In case we need the decimals
    // const token = await this.getMint(baseMint)

    // TODO: Handle Token-2022 program
    const poolBaseTokenAccount = TokenProgram.getAssociatedTokenAddressSync(new PublicKey(baseMint), poolAddress, true, TOKEN_PROGRAM_ID)
    const poolQuoteTokenAccount = TokenProgram.getAssociatedTokenAddressSync(new PublicKey(quoteMint || NATIVE_MINT), poolAddress, true, TOKEN_PROGRAM_ID)

    const [pool, poolBase, poolQuote] = await Promise.all([
      this._getPoolCached(poolAddress),
      this.getTokenAccount(poolBaseTokenAccount),
      this.getTokenAccount(poolQuoteTokenAccount)
    ])

    return {
      baseReserve: poolBase.amount,
      quoteReserve: poolQuote.amount,
      creator: pool.coin_creator
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

    const coinCreatorFeeBps = PublicKey.default.equals(reserves.creator) ? 0n : this.global.coin_creator_fee_basis_points
    const lpFeeBps = this.global.lp_fee_basis_points
    const protocolFeeBps = this.global.protocol_fee_basis_points

    const totalFeeBps = lpFeeBps + protocolFeeBps + coinCreatorFeeBps
    const totalFee = ceilDiv(quoteAmountIn * totalFeeBps, 10_000n)

    const userQuoteAmountIn = quoteAmountIn + totalFee
    const quoteAmountInWithLpFee = quoteAmountIn + ceilDiv(quoteAmountIn * lpFeeBps, 10_000n)

    const quoteInMax = calculateSlippage(userQuoteAmountIn, normalizeSlippage(slippage || 0n))

    const numerator = reserves.baseReserve * quoteAmountIn
    const denominator = reserves.quoteReserve + quoteAmountIn

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

    const numerator = reserves.quoteReserve * baseAmountOut
    const denominator = reserves.baseReserve - baseAmountOut

    if (denominator === 0n) {
      throw new Error('Pool would be depleted, denominator is zero')
    }

    const quoteAmountIn = ceilDiv(numerator, denominator)

    const lpFeeBps = this.global.lp_fee_basis_points
    const protocolFeeBps = this.global.protocol_fee_basis_points
    const coinCreatorFeeBps = PublicKey.default.equals(reserves.creator) ? 0n : this.global.coin_creator_fee_basis_points

    const lpFee = fee(quoteAmountIn, lpFeeBps)
    const protocolFee = fee(quoteAmountIn, protocolFeeBps)
    const coinCreatorFee = fee(quoteAmountIn, coinCreatorFeeBps)

    const userQuoteAmountIn = quoteAmountIn + lpFee + protocolFee + coinCreatorFee
    const quoteAmountInWithLpFee = quoteAmountIn + ceilDiv(quoteAmountIn * lpFeeBps, 10_000n)

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

    const numerator = reserves.quoteReserve * baseAmountIn
    const denominator = reserves.baseReserve + baseAmountIn

    const quoteAmountOut = denominator === 0n ? 0n : numerator / denominator

    const lpFeeBps = this.global.lp_fee_basis_points
    const protocolFeeBps = this.global.protocol_fee_basis_points
    const coinCreatorFeeBps = PublicKey.default.equals(reserves.creator) ? 0n : this.global.coin_creator_fee_basis_points

    const lpFee = fee(quoteAmountOut, lpFeeBps)
    const protocolFee = fee(quoteAmountOut, protocolFeeBps)
    const coinCreatorFee = fee(quoteAmountOut, coinCreatorFeeBps)

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
    const protocolFeeRecipient = this.global.protocol_fee_recipients[Math.floor(Math.random() * this.global.protocol_fee_recipients.length)]
    const protocolfeeRecipientTokenAccount = getProtocolFeeRecipientTokenAccount({ protocolFeeRecipient, quoteTokenProgram: TOKEN_PROGRAM_ID, quoteMint })

    const userBaseTokenAccount = TokenProgram.getAssociatedTokenAddressSync(new PublicKey(baseMint), new PublicKey(user), true, TOKEN_PROGRAM_ID)
    const userQuoteTokenAccount = TokenProgram.getAssociatedTokenAddressSync(new PublicKey(quoteMint), new PublicKey(user), true, TOKEN_PROGRAM_ID)

    const globalConfigAddress = globalConfigPda(PUMP_AMM_PROGRAM_ID)[0]

    const creatorVaultAutority = getCreatorVaultAuthority(reserves.creator)
    const creatorVaultAccount = getCreatorVaultAccount(quoteMint, creatorVaultAutority)

    return {
      pool,
      globalConfig: globalConfigAddress,
      user,
      baseMint: new PublicKey(baseMint),
      quoteMint: new PublicKey(quoteMint),
      userBaseTokenAccount,
      userQuoteTokenAccount,
      poolBaseTokenAccount: TokenProgram.getAssociatedTokenAddressSync(new PublicKey(baseMint), new PublicKey(pool), true, TOKEN_PROGRAM_ID),
      poolQuoteTokenAccount: TokenProgram.getAssociatedTokenAddressSync(new PublicKey(quoteMint), new PublicKey(pool), true, TOKEN_PROGRAM_ID),
      protocolFeeRecipient: new PublicKey(protocolFeeRecipient),
      protocolFeeRecipientTokenAccount: new PublicKey(protocolfeeRecipientTokenAccount),
      baseTokenProgram: new PublicKey(TOKEN_PROGRAM_ID),
      quoteTokenProgram: new PublicKey(TOKEN_PROGRAM_ID),
      creatorVaultAutority,
      creatorVaultAccount
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

    const poolAddress = Pumpswap.poolAddress(baseMint)
    const keys = this.keys(poolAddress, baseMint, quoteMint, user, reserves)

    const instructions = []

    // TODO: Kind of assuming everywhere that "base" is TOKEN and "quote" is SOL
    // TODO: Double check this part due similar handling of base vs quote accounts
    const ixAccountBase = this.createAccount(user, baseMint, keys.userBaseTokenAccount, null)
    const ixAccountQuote = this.createWsolAccount(user, quoteMint, keys.userQuoteTokenAccount, quoteInMax)

    if (ixAccountBase) instructions.push(...ixAccountBase)
    if (ixAccountQuote) instructions.push(...ixAccountQuote)

    // Optional hook for external encoding
    let data = !this._encode ? null : this._encode('buy', { baseOut: baseAmountOut, quoteInMax })

    if (!data) {
      // TODO: Use like: this.borsh.amm.idl.instructions.find(ix => ix.name === 'buy')
      data = Buffer.concat([
        Borsh.discriminator('global', 'buy'),
        bigintToU64LE(baseAmountOut),
        bigintToU64LE(quoteInMax)
      ])
    }

    instructions.push(new TransactionInstruction({
      programId: this.programId,

      // TODO: Use the IDL to create the keys based on "instructions->accounts"
      keys: [
        { pubkey: keys.pool, isSigner: false, isWritable: false },
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
        { pubkey: PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PUMP_AMM_PROGRAM_ID.toBase58())[0], isSigner: false, isWritable: false },
        { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false },

        { pubkey: keys.creatorVaultAccount, isSigner: false, isWritable: true },
        { pubkey: keys.creatorVaultAutority, isSigner: false, isWritable: false }
      ],
      data
    }))

    if (new PublicKey(baseMint).equals(NATIVE_MINT)) instructions.push(...this.closeAccount(user, keys.userBaseTokenAccount))
    if (ixAccountQuote) instructions.push(...this.closeAccount(user, keys.userQuoteTokenAccount))

    return instructions
  }

  sellExactIn (baseMint, quoteMint, baseAmountIn, quoteOutMin, user, reserves) {
    baseMint = new PublicKey(baseMint)
    quoteMint = new PublicKey(quoteMint)
    user = new PublicKey(user)

    baseAmountIn = normalizeBaseAmount(baseAmountIn)
    quoteOutMin = normalizeQuoteAmount(quoteOutMin)

    const poolAddress = Pumpswap.poolAddress(baseMint)
    const keys = this.keys(poolAddress, baseMint, quoteMint, user, reserves)

    const instructions = []

    const ixAccountBase = this.createWsolAccount(user, baseMint, keys.userBaseTokenAccount, baseAmountIn)
    const ixAccountQuote = this.createAccount(user, quoteMint, keys.userQuoteTokenAccount, null)

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
        { pubkey: keys.pool, isSigner: false, isWritable: false },
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
        { pubkey: PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PUMP_AMM_PROGRAM_ID.toBase58())[0], isSigner: false, isWritable: false },
        { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false },

        { pubkey: keys.creatorVaultAccount, isSigner: false, isWritable: true },
        { pubkey: keys.creatorVaultAutority, isSigner: false, isWritable: false }
      ],
      data
    }))

    if (ixAccountBase) instructions.push(...this.closeAccount(user, keys.userBaseTokenAccount))
    if (new PublicKey(quoteMint).equals(NATIVE_MINT)) instructions.push(...this.closeAccount(user, keys.userQuoteTokenAccount))

    return instructions
  }

  createAccount (user, mint, ata) {
    const instructions = []

    instructions.push(
      TokenProgram.createAssociatedTokenAccountIdempotentInstruction(user, ata, user, mint, TOKEN_PROGRAM_ID)
    )

    return instructions
  }

  createWsolAccount (user, mint, ata, amount) {
    if (new PublicKey(mint).equals(NATIVE_MINT)) {
      const instructions = []

      instructions.push(
        TokenProgram.createAssociatedTokenAccountIdempotentInstruction(user, ata, user, mint, TOKEN_PROGRAM_ID)
      )

      if (amount) {
        instructions.push(
          SystemProgram.transfer({
            fromPubkey: user,
            toPubkey: ata,
            lamports: BigInt(amount.toString())
          }),
          TokenProgram.createSyncNativeInstruction(ata)
        )
      }

      return instructions
    }

    return null
  }

  closeAccount (user, ata) {
    const instructions = []

    instructions.push(
      TokenProgram.createCloseAccountInstruction(
        ata,
        user,
        user,
        undefined,
        TOKEN_PROGRAM_ID
      )
    )

    return instructions
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
function canonicalPumpPoolPda (mint, programId, pumpProgramId) {
  const [authority] = pumpPoolAuthorityPda(mint, pumpProgramId || PUMP_PROGRAM_ID)

  return poolPda(0, authority, mint, NATIVE_MINT, programId || PUMP_AMM_PROGRAM_ID)
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

function getCreatorVaultAccount (quoteMint, vaultAutority) {
  return TokenProgram.getAssociatedTokenAddressSync(quoteMint, vaultAutority, true, TOKEN_PROGRAM_ID)
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
