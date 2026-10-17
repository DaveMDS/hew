/**
 * kernelMemory — how much memory the wasm kernel has claimed, for the
 * diagnostic log. `loader.ts` hands over the kernel's linear memory once it
 * has loaded; this module stays free of the wasm package itself, so code
 * that reads it needs no kernel (and tests that mock the loader need not
 * mock this too).
 */

let memory: WebAssembly.Memory | null = null

/** Called once by `loader.ts` with the kernel's linear memory. */
export function setKernelMemory(m: WebAssembly.Memory): void {
  memory = m
}

/** The kernel's memory in bytes, or null before it has loaded. WebAssembly
 *  memory only grows, so after a failed open this is the most the open
 *  reached: a figure near the 4 GB a wasm32 kernel can address says the
 *  open ran out of memory. */
export function kernelMemoryBytes(): number | null {
  try {
    return memory?.buffer.byteLength ?? null
  } catch {
    return null
  }
}
