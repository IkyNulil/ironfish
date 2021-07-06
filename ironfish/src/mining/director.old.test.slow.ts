/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { generateKey } from 'ironfish-wasm-nodejs'
import { Account } from '../account'
import { Assert } from '../assert'
import { waitForEmit } from '../event'
import { MemPool } from '../memPool'
import { RangeHasher } from '../merkletree'
import { SerializedBlockHeader } from '../primitives/blockheader'
import { Nullifier } from '../primitives/nullifier'
import { Target } from '../primitives/target'
import { createNodeTest, useMinerBlockFixture } from '../testUtilities'
import {
  blockHash,
  makeChainFull,
  makeChainGenesis,
  makeDbName,
  makeFakeBlock,
  makeNextBlock,
  makeNullifier,
  SerializedTestTransaction,
  TestBlockchain,
  TestMemPool,
  TestStrategy,
  TestTransaction,
} from '../testUtilities/fake'
import { makeBlockAfter } from '../testUtilities/helpers/blockchain'
import { MiningDirector } from './director'

// Number of notes and nullifiers on the initial chain created by makeFullChain
const TEST_CHAIN_NUM_NOTES = 40
const TEST_CHAIN_NUM_NULLIFIERS = 16

function generateAccount(): Account {
  const key = generateKey()

  return {
    name: 'test',
    rescan: -1,
    incomingViewKey: key.incoming_view_key,
    outgoingViewKey: key.outgoing_view_key,
    publicAddress: key.public_address,
    spendingKey: key.spending_key,
  }
}

describe('Mining director', () => {
  const strategy = new TestStrategy(new RangeHasher())
  let chain: TestBlockchain
  let targetSpy: jest.SpyInstance
  let targetMeetsSpy: jest.SpyInstance
  let verifyBlockAddSpy: jest.SpyInstance
  let memPool: TestMemPool
  let director: MiningDirector<
    string,
    string,
    TestTransaction,
    string,
    string,
    SerializedTestTransaction
  >

  beforeEach(async () => {
    chain = await makeChainGenesis(strategy, { dbPrefix: makeDbName() })

    verifyBlockAddSpy = jest.spyOn(chain.verifier, 'verifyBlockAdd').mockResolvedValue({
      valid: true,
    })

    for (let i = 1; i < 8 * 5; i++) {
      await chain.notes.add(`${i}`)

      if (i % 5 < 2) {
        await chain.nullifiers.add(makeNullifier(i))
      }

      if ((i + 1) % 5 === 0) {
        await chain.addBlock(await makeNextBlock(chain))
      }
    }

    memPool = new MemPool({
      chain: chain,
      strategy: chain.strategy,
    })

    director = new MiningDirector({
      chain: chain,
      memPool: memPool,
      strategy: chain.strategy,
      force: true,
    })

    director.setMinerAccount(generateAccount())

    targetSpy = jest.spyOn(Target, 'minDifficulty').mockImplementation(() => BigInt(1))
    targetMeetsSpy = jest.spyOn(Target, 'meets').mockImplementation(() => true)

    await director.start()
  })

  afterEach(() => {
    director.shutdown()
  })

  afterAll(() => {
    targetSpy.mockClear()
    targetMeetsSpy.mockClear()
    verifyBlockAddSpy.mockClear()
  })

  it('adds transactions from the queue to a new block to be mined', async () => {
    director.memPool.acceptTransaction(
      new TestTransaction(true, ['abc', 'def'], 50, [
        { nullifier: makeNullifier(8), commitment: '0-3', size: 4 },
      ]),
    )

    director.memPool.acceptTransaction(
      new TestTransaction(true, ['jkl', 'mno'], 40, [
        { nullifier: makeNullifier(9), commitment: '0-3', size: 4 },
      ]),
    )
    const chainHead = await chain.getBlock(chain.head.hash)
    Assert.isNotNull(chainHead)

    const listenPromise = waitForEmit(director.onBlockToMine)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await chain.onConnectBlock.emitAsync(chainHead)

    const result = (await listenPromise)[0]
    const buffer = Buffer.from(result.bytes)
    const block = JSON.parse(buffer.toString()) as SerializedBlockHeader<string>

    expect(block.noteCommitment.size).toBe(TEST_CHAIN_NUM_NOTES + 5)
    expect(block.nullifierCommitment.size).toBe(TEST_CHAIN_NUM_NULLIFIERS + 2)
    expect(block).toMatchSnapshot({ timestamp: expect.any(Number) })
    // Transactions stay in the queue until they are mined
    expect(director.memPool.size()).toBe(2)
  })

  it('does not add invalid transactions to the block', async () => {
    director.memPool.acceptTransaction(
      new TestTransaction(false, ['abc', 'def'], 50, [
        { nullifier: makeNullifier(8), commitment: 'ghi', size: 4 },
      ]),
    )

    director.memPool.acceptTransaction(
      new TestTransaction(false, ['jkl', 'mno'], 40, [
        { nullifier: makeNullifier(9), commitment: 'pqr', size: 4 },
      ]),
    )

    const chainHead = await chain.getBlock(chain.head.hash)
    Assert.isNotNull(chainHead)

    const listenPromise = waitForEmit(director.onBlockToMine)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await chain.onConnectBlock.emitAsync(chainHead)

    const result = (await listenPromise)[0]
    const buffer = Buffer.from(result.bytes)
    const block = JSON.parse(buffer.toString()) as SerializedBlockHeader<string>

    expect(block.noteCommitment.size).toBe(TEST_CHAIN_NUM_NOTES + 1)
    expect(block.nullifierCommitment.size).toBe(TEST_CHAIN_NUM_NULLIFIERS)
    expect(block).toMatchSnapshot({ timestamp: expect.any(Number) })
    expect(director.memPool.size()).toBe(0)
  })
})

// TODO: Move these to MemPool
describe('isValidTransaction', () => {
  const strategy = new TestStrategy(new RangeHasher())
  let chain: TestBlockchain
  let memPool: TestMemPool

  beforeEach(async () => {
    chain = await makeChainFull(strategy)

    memPool = new MemPool({
      chain: chain,
      strategy: chain.strategy,
    })
  })

  it('is not valid if the spend was seen in other transactions in this block', async () => {
    const transaction = new TestTransaction(true, ['abc', 'def'], 50, [
      { nullifier: makeNullifier(8), commitment: '0-3', size: 4 },
    ])

    const beforeSize = TEST_CHAIN_NUM_NULLIFIERS
    const seenNullifiers = [makeNullifier(8)]
    const isValid = await memPool.isValidTransaction(transaction, beforeSize, seenNullifiers)
    expect(isValid).toBe(false)
  })

  it('is not valid if the spend was seen in a previous block', async () => {
    const aPreviousNullifier = await chain.nullifiers.get(4)

    const transaction = new TestTransaction(true, ['abc', 'def'], 50, [
      { nullifier: aPreviousNullifier, commitment: '0-3', size: 4 },
    ])

    const beforeSize = TEST_CHAIN_NUM_NULLIFIERS
    const seenNullifiers: Nullifier[] = []
    const isValid = await memPool.isValidTransaction(transaction, beforeSize, seenNullifiers)
    expect(isValid).toBe(false)
  })

  it('Updates seenNullifiers with valid transactions', async () => {
    const seenNullifiers: Nullifier[] = []
    const beforeSize = TEST_CHAIN_NUM_NULLIFIERS
    let transaction = new TestTransaction(true, ['abc', 'def'], 50, [
      { nullifier: makeNullifier(8), commitment: '0-3', size: 4 },
    ])
    let isValid = await memPool.isValidTransaction(transaction, beforeSize, seenNullifiers)
    expect(isValid).toBe(true)
    expect(seenNullifiers).toHaveLength(1)

    transaction = new TestTransaction(true, ['jkl', 'mno'], 40, [
      { nullifier: makeNullifier(9), commitment: '0-3', size: 4 },
    ])
    isValid = await memPool.isValidTransaction(transaction, beforeSize, seenNullifiers)
    expect(isValid).toBe(true)
    expect(seenNullifiers).toHaveLength(2)
  })
})

describe('successfullyMined', () => {
  const strategy = new TestStrategy(new RangeHasher())
  let chain: TestBlockchain
  let memPool: TestMemPool
  let director: MiningDirector<
    string,
    string,
    TestTransaction,
    string,
    string,
    SerializedTestTransaction
  >

  beforeEach(async () => {
    chain = await makeChainFull(strategy)

    memPool = new MemPool({
      chain: chain,
      strategy: chain.strategy,
    })

    director = new MiningDirector({
      chain: chain,
      memPool: memPool,
      strategy: chain.strategy,
      force: true,
    })

    director.setMinerAccount(generateAccount())
  })

  afterEach(() => {
    director.shutdown()
  })

  it('emits nothing on mining if the block id is not known', async () => {
    const onNewBlockSpy = jest.spyOn(director.onNewBlock, 'emit')

    await director.successfullyMined(5, 0)

    expect(onNewBlockSpy).not.toBeCalled()
  })

  it('submits nothing if the block invalid', async () => {
    const onNewBlockSpy = jest.spyOn(director.onNewBlock, 'emit')

    const block = makeFakeBlock(strategy, blockHash(9), blockHash(10), 10, 8, 20)
    block.transactions[0].isValid = false
    director.recentBlocks.set(1, block)
    await director.successfullyMined(5, 1)

    expect(onNewBlockSpy).not.toBeCalled()
  })
})

describe('Non-fake director tests', () => {
  describe('successfullyMined', () => {
    const nodeTest = createNodeTest()

    it('rejects if chain head has changed', async () => {
      const { strategy, chain, node } = nodeTest
      strategy.disableMiningReward()

      const blockA1 = await makeBlockAfter(chain, chain.genesis)
      const blockA2 = await makeBlockAfter(chain, chain.genesis)
      node.miningDirector.recentBlocks.set(2, blockA1)
      node.miningDirector.recentBlocks.set(3, blockA2)

      const addSpy = jest.spyOn(chain, 'addBlock')

      await node.miningDirector.successfullyMined(1, 2)
      expect(addSpy).toBeCalledTimes(1)
      addSpy.mockClear()

      await node.miningDirector.successfullyMined(2, 3)
      expect(addSpy).not.toBeCalled()
    })

    it('does not emit if block cannot be added to chain', async () => {
      const { strategy, chain, node } = nodeTest
      strategy.disableMiningReward()

      const block = await makeBlockAfter(chain, chain.genesis)
      block.header.nullifierCommitment.size = 999

      const addSpy = jest.spyOn(chain, 'addBlock')
      const emitSpy = jest.spyOn(node.miningDirector.onNewBlock, 'emit')

      node.miningDirector.recentBlocks.set(1, block)
      await node.miningDirector.successfullyMined(1, 1)
      expect(addSpy).toBeCalledTimes(1)

      await expect(addSpy.mock.results[0].value).resolves.toMatchObject({
        isAdded: false,
      })
      expect(emitSpy).not.toBeCalled()
    })

    it('submits a validly mined block', async () => {
      const { strategy, chain, node } = nodeTest
      strategy.disableMiningReward()

      const onNewBlockSpy = jest.spyOn(node.miningDirector.onNewBlock, 'emit')

      const block = await useMinerBlockFixture(chain, 2)
      node.miningDirector.recentBlocks.set(1, block)
      await node.miningDirector.successfullyMined(5, 1)

      expect(onNewBlockSpy).toBeCalledWith(block)
    })
  })
})

describe('Recalculating target', () => {
  const minDifficulty = Target.minDifficulty()
  const strategy = new TestStrategy(new RangeHasher())
  let chain: TestBlockchain
  let memPool: TestMemPool
  let director: MiningDirector<
    string,
    string,
    TestTransaction,
    string,
    string,
    SerializedTestTransaction
  >
  jest.setTimeout(15000)

  beforeEach(async () => {
    jest.useFakeTimers()
    jest.setTimeout(15000000)

    chain = await makeChainFull(strategy)

    memPool = new MemPool({
      chain: chain,
      strategy: chain.strategy,
    })

    director = new MiningDirector({
      chain: chain,
      memPool: memPool,
      strategy: chain.strategy,
      force: true,
    })

    director.setMinerAccount(generateAccount())
    await director.start()
  })

  afterAll(() => {
    jest.useRealTimers()
    director.shutdown()
  })

  it('after 10 seconds the block header is updated and target is re-calculated if difficulty is high', async () => {
    const newTarget = Target.fromDifficulty(minDifficulty + BigInt(10000000000))
    jest.spyOn(Target, 'calculateTarget').mockReturnValueOnce(newTarget)

    const heaviestHeader = director.chain.head
    Assert.isNotNull(heaviestHeader)

    const spy = jest.spyOn(director, 'constructAndMineBlock')

    await director.onChainHeadChange(heaviestHeader.recomputeHash())

    jest.advanceTimersByTime(11000)
    expect(spy).toBeCalledTimes(2)
  })

  it('after 10 seconds the block header is not updated and target is not re-calculated if difficulty is at minimum', async () => {
    const newTarget = Target.fromDifficulty(minDifficulty)
    jest.spyOn(Target, 'calculateTarget').mockReturnValueOnce(newTarget)

    const heaviestHeader = director.chain.head
    Assert.isNotNull(heaviestHeader)

    const spy = jest.spyOn(director, 'constructAndMineBlock')
    await director.onChainHeadChange(heaviestHeader.recomputeHash())

    jest.advanceTimersByTime(11000)
    expect(spy).toBeCalledTimes(1)
  })
})