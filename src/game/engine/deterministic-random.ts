import seedrandom from 'seedrandom'

export class DeterministicRandom {
  private readonly generator: seedrandom.PRNG

  constructor(seed: string, turnIndex: number) {
    this.generator = seedrandom(`${seed}:${turnIndex}`)
  }

  next(): number {
    return this.generator.quick()
  }

  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min
  }

  chance(probability: number): boolean {
    return this.next() < probability
  }
}
