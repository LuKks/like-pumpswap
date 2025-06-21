const test = require('brittle')
const SOL = require('like-solana')
const dotenv = require('dotenv')
const Pumpswap = require('./index.js')

dotenv.config({ path: require('os').homedir() + '/.env' })

test('canonical pump pool PDA', async function (t) {
  const mintAddress = '2fWkVf417bfxEgUemymkYNagXVitnmNxvq7dhUwnpump'
  const poolAddress = Pumpswap.poolAddress(mintAddress)

  t.alike(poolAddress.toBase58(), '6NwddQ9YFo7EJUfZ9F5FGRZhh7SMYoVASePNC8mKnWZo')
})

test('buyExactOut and sellExactIn', async function (t) {
  const user = new SOL.Keypair(process.env.WALLET_SECRET_KEY)

  const rpc = new SOL.RPC({ url: process.env.RPC_URL, commitment: 'processed' })
  const pump = new Pumpswap(rpc)

  await pump.ready()

  const recentBlockhash = (await rpc.getLatestBlockhash()).blockhash

  const baseMint = '2fWkVf417bfxEgUemymkYNagXVitnmNxvq7dhUwnpump'
  const quoteMint = 'So11111111111111111111111111111111111111112'

  // [BUY]
  const reserves = await pump.getReserves(baseMint, quoteMint)

  const swapBuy = pump.quoteToBase(0.001, reserves, 500n)

  t.comment('BUY', swapBuy)

  const ixBuy = pump.buyExactOut(baseMint, quoteMint, swapBuy.baseAmountOut, swapBuy.quoteInMax, user.publicKey, reserves)

  const tx1 = SOL.sign(ixBuy, { unitPrice: 0.0001, signers: [user], recentBlockhash })

  t.comment('Buy hash', SOL.signature(tx1))

  await rpc.sendTransaction(tx1, { confirmed: true })
  await new Promise(resolve => setTimeout(resolve, 5000))

  // [SELL]
  const reserves2 = await pump.getReserves(baseMint, quoteMint)

  const swapSell = pump.baseToQuote(swapBuy.baseAmountOut, reserves2, 500n)

  t.comment('SELL', swapSell)

  const ixSell = pump.sellExactIn(baseMint, quoteMint, swapSell.baseAmountIn, swapSell.quoteOutMin, user.publicKey, reserves2)

  const tx2 = SOL.sign(ixSell, { unitPrice: 0.0001, signers: [user], recentBlockhash })

  t.comment('Sell hash', SOL.signature(tx2))

  await rpc.sendTransaction(tx2, { confirmed: true })
  await new Promise(resolve => setTimeout(resolve, 5000))
})

test('sync reserves', { timeout: 60000 }, async function (t) {
  const user = new SOL.Keypair(process.env.WALLET_SECRET_KEY)

  const rpc = new SOL.RPC({ commitment: 'processed' })
  const pump = new Pumpswap(rpc)

  await pump.ready()

  const recentBlockhash = (await rpc.getLatestBlockhash()).blockhash

  const baseMint = '2fWkVf417bfxEgUemymkYNagXVitnmNxvq7dhUwnpump'
  const quoteMint = 'So11111111111111111111111111111111111111112'

  // [BUY]
  const reserves = await pump.getReserves(baseMint, quoteMint)

  const swapBuy = pump.quoteToBase(0.001, reserves, 0n)

  t.comment('BUY', swapBuy)

  pump.sync(swapBuy, reserves)

  const ixBuy = pump.buyExactOut(baseMint, quoteMint, swapBuy.baseAmountOut, swapBuy.quoteInMax, user.publicKey, reserves)

  const tx1 = SOL.sign(ixBuy, { unitPrice: 0.0001, signers: [user], recentBlockhash })

  t.comment('Buy hash', SOL.signature(tx1))

  await rpc.sendTransaction(tx1, { confirmed: true })
  await new Promise(resolve => setTimeout(resolve, 5000))

  // [SELL]
  const reserves2 = await pump.getReserves(baseMint, quoteMint)

  t.alike(reserves2, reserves)

  const swapSell = pump.baseToQuote(swapBuy.baseAmountOut, reserves2, 0n)

  t.comment('SELL', swapSell)

  pump.sync(swapSell, reserves)

  const ixSell = pump.sellExactIn(baseMint, quoteMint, swapSell.baseAmountIn, swapSell.quoteOutMin, user.publicKey, reserves)

  const tx2 = SOL.sign(ixSell, { unitPrice: 0.0001, signers: [user], recentBlockhash })

  t.comment('Sell hash', SOL.signature(tx2))

  await rpc.sendTransaction(tx2, { confirmed: true })
  await new Promise(resolve => setTimeout(resolve, 5000))

  const reserves3 = await pump.getReserves(baseMint, quoteMint)

  t.alike(reserves3, reserves)
})

test('offline swaps', async function (t) {
  const user = new SOL.Keypair(process.env.WALLET_SECRET_KEY)

  const rpc = new SOL.RPC({ url: process.env.RPC_URL, commitment: 'processed' })
  const pump = new Pumpswap(rpc)

  await pump.ready()

  const recentBlockhash = (await rpc.getLatestBlockhash()).blockhash

  const baseMint = '2fWkVf417bfxEgUemymkYNagXVitnmNxvq7dhUwnpump'

  const reserves = await pump.getReserves(baseMint)

  const swapBuy = pump.quoteToBase(0.001, reserves, 0n, { sync: true })
  const swapSell = pump.baseToQuote(swapBuy.baseAmountOut, reserves, 0n, { sync: true })

  const ixBuy = pump.buy(baseMint, swapBuy.baseAmountOut, swapBuy.quoteInMax, user.publicKey, reserves)
  const ixSell = pump.sell(baseMint, swapSell.baseAmountIn, swapSell.quoteOutMin, user.publicKey, reserves)

  const tx1 = SOL.sign(ixBuy, { unitPrice: 0.0001, signers: [user], recentBlockhash })
  const tx2 = SOL.sign(ixSell, { unitPrice: 0.0001, signers: [user], recentBlockhash })

  t.comment('Buy hash', SOL.signature(tx1))
  t.comment('Sell hash', SOL.signature(tx2))

  await rpc.sendTransaction(tx1)
  await new Promise(resolve => setTimeout(resolve, 3000))
  await rpc.sendTransaction(tx2)

  await rpc.confirmTransaction(SOL.signature(tx1))
  await rpc.confirmTransaction(SOL.signature(tx2))

  await new Promise(resolve => setTimeout(resolve, 5000))

  const reserves2 = await pump.getReserves(baseMint)

  t.alike(reserves2, reserves)
})

// TODO
test.skip('token programs', async function (t) {
  const rpc = new SOL.RPC({ commitment: 'processed' })
  const pump = new Pumpswap(rpc)

  // Token Program: TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
  // Token 2022: TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb

  const OLD_MINT = '481bUQXurfydUn3QEzfHrhjWax1eNea54JngdVdcpump'
  // const NEW_MINT = '...'

  const [oldPoolAddress] = Pumpswap.canonicalPumpPoolPda(OLD_MINT)
  // const [newPoolAddress] = Pumpswap.canonicalPumpPoolPda(NEW_MINT)

  const oldPool = await pump.fetchPool(oldPoolAddress)
  console.log(oldPool)

  // const newPool = await pump.fetchPool(newPoolAddress)
  // console.log(newPool)

  console.log(await pump.getTokenAccount(oldPool.pool_base_token_account))
  // console.log(await pump.getTokenAccount(NEW_MINT))
})
