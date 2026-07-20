import { sha512 } from '@noble/hashes/sha2.js'
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import type { Rng } from './group.ts'

/** Deterministic RNG for reproducible tests: SHA-512 counter stream. */
export function seededRng(seed: string): Rng {
  let counter = 0
  return (len: number) => {
    const chunks: Uint8Array[] = []
    let have = 0
    while (have < len) {
      const block = sha512(utf8ToBytes(`${seed}:${counter++}`))
      chunks.push(block)
      have += block.length
    }
    return concatBytes(...chunks).subarray(0, len)
  }
}
