# like-pumpswap

Buy and sell tokens on swap.pump.fun (AMM) easily

```
npm i like-pumpswap
```

## Usage

Both `like-pumpfun` and `like-pumpswap` have similar API on purpose for easyness.

They have different math and instructions underneath.

<details>
<summary>Full example for buying and selling</summary>

Get mint reserves, estimate the swap, create instructions, sign, and send.

```js
const Pumpswap = require('like-pumpswap')
const SOL = require('like-solana')

const rpc = new SOL.RPC()
const pumpswap = new Pumpswap(rpc)

main()

async function main () {
  const baseMint = '2fWkVf417bfxEgUemymkYNagXVitnmNxvq7dhUwnpump'
  const quoteMint = 'So11111111111111111111111111111111111111112'
  const recentBlockhash = (await rpc.getLatestBlockhash()).blockhash
  const user = new SOL.Keypair('<secret key...>')

  // Buy 0.1 SOL of tokens with 3% slippage
  const reserves = await pumpswap.getReserves(baseMint, quoteMint)
  const swapBuy = pumpswap.quoteToBase(0.1, reserves, 0.03)
  const ixBuy = pumpswap.buyExactOut(baseMint, quoteMint, swapBuy.baseAmountOut, swapBuy.quoteInMax, user.publicKey, reserves)
  const txBuy = SOL.sign(ixBuy, { unitPrice: 0.0001, signers: [user], recentBlockhash })

  console('Buy signature:', SOL.signature(txBuy))

  await rpc.sendTransaction(txBuy)

  // ... (could wait for confirmation)
  await new Promise(resolve => setTimeout(resolve, 5000))

  // Sell the tokens we bought with 3% slippage
  const reserves2 = await pumpswap.getReserves(baseMint, quoteMint)
  const swapSell = pumpswap.baseToQuote(swapBuy.baseAmountOut, reserves2, 0.03)
  const ixSell = pumpswap.sellExactIn(baseMint, quoteMint, swapSell.baseAmountIn, swapSell.quoteOutMin, user.publicKey, reserves)
  const txSell = SOL.sign(ixSell, { unitPrice: 0.0001, signers: [user], recentBlockhash })

  console('Sell signature:', SOL.signature(txSell))

  await rpc.sendTransaction(txSell)

  // ...
}
```
</details>

## API

#### `pumpswap = new Pumpswap(rpc)`

Create a new Pumpswap instance.

A `solana-rpc` instance must be provided.

#### `reserves = await pumpswap.getReserves(baseMint[, quoteMint])`

Fetch the pool, base, and quote as reserves.

The quote mint is `So11111111111111111111111111111111111111112` by default.

Returns:

```js
{
  baseReserve: BigInt,
  quoteReserve: BigInt,
  creator: String
}
```

## Buy

#### `swap = pumpswap.quoteToBase(quoteAmountIn, reserves[, slippage, options])`

Buy estimation on how many tokens you will receive based on quote (SOL).

Slippage is zero by default, you expect to receive what you estimated or more.

```js
// 0.5 SOL to TOKENS at 3% slippage (Auto-converted to BigInt)
const swapBuy = pumpswap.quoteToBase(0.5, reserves, 0.03)

// BigInt(0.5 * 1e9) to TOKENS (Nine decimals)
const swapBuy = pumpswap.quoteToBase(500000000n, reserves, 0.03)
```

Options:

```js
{
  sync: Boolean // For multiple continuous swaps
}
```

Returns:

```js
{
  baseAmountOut: BigInt,
  quoteAmountIn: BigInt,
  quoteAmountInWithLpFee: BigInt,
  userQuoteAmountIn: BigInt,
  quoteInMax: BigInt
}
```

#### `ix = pumpswap.buyExactOut(baseMint, quoteMint, baseAmountOut, quoteInMax, userPublicKey, reserves)`

Create buy instructions for any pair of tokens.

Use `quoteToBase` to calculate the amounts, unless you already know them.

## Sell

#### `swap = pumpswap.baseToQuote(baseAmountIn, reserves[, slippage, options])`

Sell estimation on how much SOL you will receive based on base (tokens).

Slippage is zero by default, you expect to receive what you estimated or more.

```js
// 350000000 TOKENS to SOL at 3% slippage (Auto-converted to BigInt)
const swapSell = pumpswap.baseToQuote(350000000, reserves, 0.03)

// BigInt(350000000 * 1e6) to TOKENS (Six decimals)
const swapSell = pumpswap.baseToQuote(350000000000000n, reserves, 0.03)
```

Options:

```js
{
  sync: Boolean // For multiple continuous swaps
}
```

Returns:

```js
{
  baseAmountIn: BigInt,
  quoteAmountOut: BigInt,
  quoteAmountOutWithoutLpFee: BigInt,
  userQuoteAmountOut: BigInt,
  quoteOutMin: BigInt
}
```

#### `ix = pumpswap.sellExactIn(baseMint, quoteMint, baseAmountIn, quoteOutMin, userPublicKey, reserves)`

Create sell instructions for any pair of tokens.

Use `baseToQuote` to calculate the amounts, unless you already know them.

## Pumpfun compatible

#### `ix = pumpswap.buy(mint, baseAmountOut, quoteInMax, userPublicKey, reserves)`

Create buy instructions. This mimics the API from `like-pumpfun` on purpose.

Internally, it uses `buyExactOut`.

Note: Reserves here specifically only needs `{ creator }`.

#### `ix = pumpswap.sell(mint, baseAmountIn, quoteOutMin, userPublicKey, reserves)`

Create sell instructions. This mimics the API from `like-pumpfun` on purpose.

Internally, it uses `sellExactIn`.

Note: Reserves here specifically only needs `{ creator }`.

## API

#### `pool = await pumpswap.getPool(poolAddress)`

Fetch the latest pool data on-chain.

#### `mint = await pumpswap.getMint(mintAddress)`

Fetch the latest mint data on-chain.

#### `tokenAccount = await pumpswap.getTokenAccount(address)`

Fetch the latest token account data on-chain.

## API (static)

#### `Pumpswap.PROGRAM_ID`

Indicates the program ID: `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`

#### `marketCap = Pumpswap.marketCap(reserves)`

Calculates the market capitalization of the token.

#### `price = Pumpswap.price(reserves)`

Calculates the price of 1 token in SOL (lamport units).

#### `poolAddress = Pumpswap.poolAddress(mint)`

Returns the pool address based on the mint public key.

#### `config = Pumpswap.global()`

Returns the global config (admin, fees, flags, etcetera).

## License

MIT
