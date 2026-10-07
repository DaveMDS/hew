import { describe, it, expect, vi } from 'vitest'
import { RetypeWindow, idleRetypeCapturesKey, retypeStaleMessage } from './retypeWindow'

/** A history stand-in: the generation moves on every recorded action, undo,
 *  and redo, like the kernel's; `record()` is "the tool committed something". */
function makeScene() {
  let gen = 1n
  const scene = {
    history_generation: vi.fn(() => gen),
    scene_undo: vi.fn(() => { gen += 1n; return { free: vi.fn() } }),
    scene_redo: vi.fn(() => { gen += 1n; return { free: vi.fn() } }),
    record: () => { gen += 1n },
  }
  return scene
}

type Spec = { size: number }

describe('RetypeWindow', () => {
  it('starts closed; arm opens it on the current generation', () => {
    const scene = makeScene()
    const w = new RetypeWindow<Spec>(scene)
    expect(w.isOpen).toBe(false)
    expect(w.spec).toBe(null)
    w.arm({ size: 1 })
    expect(w.isOpen).toBe(true)
    expect(w.spec).toEqual({ size: 1 })
    w.close()
    expect(w.isOpen).toBe(false)
  })

  it('apply on a closed window does nothing', () => {
    const scene = makeScene()
    const w = new RetypeWindow<Spec>(scene)
    const recommit = vi.fn(() => true)
    expect(w.apply(recommit, () => true, (s) => s)).toBe('closed')
    expect(recommit).not.toHaveBeenCalled()
    expect(scene.scene_undo).not.toHaveBeenCalled()
  })

  it('ok: one undo, the re-commit, and the window re-armed on the next spec at the new generation', () => {
    const scene = makeScene()
    const w = new RetypeWindow<Spec>(scene)
    w.arm({ size: 1 })
    const recommit = vi.fn((_s: Spec) => { scene.record(); return true })
    expect(w.apply(recommit, () => true, () => ({ size: 2 }))).toBe('ok')
    expect(scene.scene_undo).toHaveBeenCalledTimes(1)
    expect(recommit).toHaveBeenCalledWith({ size: 1 })
    expect(w.spec).toEqual({ size: 2 })
    // Re-armed at the CURRENT generation: a second apply goes through.
    expect(w.apply(recommit, () => true, () => ({ size: 3 }))).toBe('ok')
    expect(scene.scene_undo).toHaveBeenCalledTimes(2)
  })

  it('a bracketed re-commit counts as ONE step by undo depth, though the generation moved several times', () => {
    // The kernel's generation counts every push: a bracket's inner edits
    // plus the compound it drains them into. The depth moves by one.
    let gen = 1n
    let depth = 5
    const scene = {
      history_generation: vi.fn(() => gen),
      undo_depth: vi.fn(() => depth),
      scene_undo: vi.fn(() => { gen += 1n; depth -= 1; return { free: vi.fn() } }),
      scene_redo: vi.fn(() => { gen += 1n; depth += 1; return { free: vi.fn() } }),
    }
    const bracketed = () => { gen += 4n; depth += 1 }
    const w = new RetypeWindow<Spec>(scene)
    bracketed()
    w.arm({ size: 1 })
    const recommit = vi.fn((_s: Spec) => { bracketed(); return true })
    expect(w.apply(recommit, () => true, () => ({ size: 2 }))).toBe('ok')
    expect(w.apply(recommit, () => true, () => ({ size: 3 }))).toBe('ok')
    // Two retypes, one undo each: earlier history (depth 5) is untouched.
    expect(scene.scene_undo).toHaveBeenCalledTimes(2)
    expect(depth).toBe(6)
  })

  it('stale: an intervening recorded action closes the window and nothing is undone', () => {
    const scene = makeScene()
    const w = new RetypeWindow<Spec>(scene)
    w.arm({ size: 1 })
    scene.record()
    const recommit = vi.fn(() => true)
    expect(w.apply(recommit, () => true, (s) => s)).toBe('stale')
    expect(scene.scene_undo).not.toHaveBeenCalled()
    expect(recommit).not.toHaveBeenCalled()
    expect(w.isOpen).toBe(false)
  })

  it('failed with nothing recorded: a redo restores the original and the window stays open', () => {
    const scene = makeScene()
    const w = new RetypeWindow<Spec>(scene)
    w.arm({ size: 1 })
    const restore = vi.fn(() => true)
    expect(w.apply(() => false, restore, () => ({ size: 9 }))).toBe('failed')
    expect(scene.scene_undo).toHaveBeenCalledTimes(1)
    expect(scene.scene_redo).toHaveBeenCalledTimes(1)
    expect(restore).not.toHaveBeenCalled()
    expect(w.spec).toEqual({ size: 1 })
    expect(w.isOpen).toBe(true)
    // Re-stamped: a good retype now goes through.
    expect(w.apply(() => { scene.record(); return true }, restore, () => ({ size: 2 }))).toBe('ok')
  })

  it('failed with a PARTIAL step recorded: undo it and redraw the original — never a redo', () => {
    const scene = makeScene()
    const w = new RetypeWindow<Spec>(scene)
    w.arm({ size: 1 })
    const restore = vi.fn((_s: Spec) => { scene.record(); return true })
    // The refused re-commit still recorded something (a partial gesture).
    expect(w.apply(() => { scene.record(); return false }, restore, () => ({ size: 9 }))).toBe('failed')
    expect(scene.scene_undo).toHaveBeenCalledTimes(2)
    expect(scene.scene_redo).not.toHaveBeenCalled()
    expect(restore).toHaveBeenCalledWith({ size: 1 })
    expect(w.isOpen).toBe(true)
    expect(w.spec).toEqual({ size: 1 })
  })

  it('failed and the restore itself refused: the window closes', () => {
    const scene = makeScene()
    const w = new RetypeWindow<Spec>(scene)
    w.arm({ size: 1 })
    expect(w.apply(() => { scene.record(); return false }, () => false, (s) => s)).toBe('failed')
    expect(w.isOpen).toBe(false)
  })

  it('a throwing redo closes the window rather than leaving a stale stamp', () => {
    const scene = makeScene()
    scene.scene_redo.mockImplementation(() => { throw new Error('nothing to redo') })
    const w = new RetypeWindow<Spec>(scene)
    w.arm({ size: 1 })
    expect(w.apply(() => false, () => true, (s) => s)).toBe('failed')
    expect(w.isOpen).toBe(false)
  })
})

describe('RetypeWindow — multi-step commits', () => {
  it('armFrom measures the entries from the generation before the commit; apply undoes that many', () => {
    const scene = makeScene()
    const w = new RetypeWindow<Spec>(scene)
    const g0 = scene.history_generation()
    scene.record(); scene.record() // a commit that recorded two steps
    w.armFrom({ size: 1 }, g0)
    expect(w.apply(() => { scene.record(); return true }, () => true, () => ({ size: 2 }))).toBe('ok')
    expect(scene.scene_undo).toHaveBeenCalledTimes(2)
    // The re-commit recorded ONE step, so the window now retracts one.
    expect(w.apply(() => { scene.record(); return true }, () => true, () => ({ size: 3 }))).toBe('ok')
    expect(scene.scene_undo).toHaveBeenCalledTimes(3)
  })

  it('a refused re-commit that recorded nothing redoes every retracted step', () => {
    const scene = makeScene()
    const w = new RetypeWindow<Spec>(scene)
    w.arm({ size: 1 }, 2)
    expect(w.apply(() => false, () => true, (s) => s)).toBe('failed')
    expect(scene.scene_undo).toHaveBeenCalledTimes(2)
    expect(scene.scene_redo).toHaveBeenCalledTimes(2)
    expect(w.isOpen).toBe(true)
  })

  it('a refused re-commit that recorded partial steps undoes exactly those, then restores', () => {
    const scene = makeScene()
    const w = new RetypeWindow<Spec>(scene)
    w.arm({ size: 1 }, 2)
    const restore = vi.fn((_s: Spec) => { scene.record(); scene.record(); return true })
    expect(w.apply(() => { scene.record(); scene.record(); scene.record(); return false }, restore, (s) => s)).toBe('failed')
    // 2 (retract) + 3 (the partial steps) undos, no redo, one restore.
    expect(scene.scene_undo).toHaveBeenCalledTimes(5)
    expect(scene.scene_redo).not.toHaveBeenCalled()
    expect(restore).toHaveBeenCalledTimes(1)
    // The restore recorded two steps: the window retracts two next time.
    expect(w.apply(() => { scene.record(); return true }, () => true, (s) => s)).toBe('ok')
    expect(scene.scene_undo).toHaveBeenCalledTimes(7)
  })
})

describe('RetypeWindow.retract', () => {
  it('undoes the committed steps and closes; stale when the generation moved', () => {
    const scene = makeScene()
    const w = new RetypeWindow<Spec>(scene)
    w.arm({ size: 1 }, 2)
    expect(w.retract()).toBe('ok')
    expect(scene.scene_undo).toHaveBeenCalledTimes(2)
    expect(w.isOpen).toBe(false)
    expect(w.retract()).toBe('closed')
    w.arm({ size: 1 })
    scene.record()
    expect(w.retract()).toBe('stale')
    expect(scene.scene_undo).toHaveBeenCalledTimes(2)
    expect(w.isOpen).toBe(false)
  })
})

describe('idleRetypeCapturesKey', () => {
  const grammar = (k: string) => k === '.' || k === 'm' || k === 'Backspace'

  it('a digit always opens the entry', () => {
    expect(idleRetypeCapturesKey('5', '', grammar)).toBe(true)
  })

  it('a leading minus or point opens the entry as well (a flipped or fractional value)', () => {
    expect(idleRetypeCapturesKey('-', '', grammar)).toBe(true)
    expect(idleRetypeCapturesKey('.', '', grammar)).toBe(true)
  })

  it('with an empty buffer nothing else is taken (letters keep their shortcuts, Space resets)', () => {
    for (const k of ['m', ' ', 'Enter', 'Backspace', 'p']) {
      expect(idleRetypeCapturesKey(k, '', grammar)).toBe(false)
    }
  })

  it('Space is never taken, buffer or not — it is the global reset-to-Select', () => {
    expect(idleRetypeCapturesKey(' ', '5', (k) => k === ' ')).toBe(false)
  })

  it('with something typed, Enter and the tool grammar follow; other keys still fall through', () => {
    expect(idleRetypeCapturesKey('Enter', '5', grammar)).toBe(true)
    expect(idleRetypeCapturesKey('m', '5', grammar)).toBe(true)
    expect(idleRetypeCapturesKey('.', '5', grammar)).toBe(true)
    expect(idleRetypeCapturesKey('p', '5', grammar)).toBe(false)
    expect(idleRetypeCapturesKey('q', '5', grammar)).toBe(false)
  })
})

describe('RetypeWindow — refusal rollback by generation', () => {
  /** A history that also reports its stack depth. */
  function makeDepthScene() {
    let gen = 1n
    let depth = 0
    return {
      history_generation: () => gen,
      undo_depth: () => depth,
      scene_undo: vi.fn(() => { gen += 1n; depth -= 1; return { free: vi.fn() } }),
      scene_redo: vi.fn(() => { gen += 1n; depth += 1; return { free: vi.fn() } }),
      record: () => { gen += 1n; depth += 1 },
    }
  }

  it('a refusal that never moved the generation redoes the retracted steps', () => {
    const scene = makeDepthScene()
    scene.record()
    const w = new RetypeWindow<Spec>(scene)
    w.arm({ size: 1 })
    expect(w.apply(() => false, () => true, (s) => s)).toBe('failed')
    expect(scene.scene_redo).toHaveBeenCalledTimes(1)
    expect(scene.undo_depth()).toBe(1)
    expect(w.isOpen).toBe(true)
  })

  it('a refusal that recorded (net) steps retracts exactly those, then restores', () => {
    const scene = makeDepthScene()
    scene.record()
    const w = new RetypeWindow<Spec>(scene)
    w.arm({ size: 1 })
    const restore = vi.fn(() => { scene.record(); return true })
    expect(w.apply(() => { scene.record(); return false }, restore, (s) => s)).toBe('failed')
    expect(restore).toHaveBeenCalledTimes(1)
    expect(scene.undo_depth()).toBe(1)
  })
})

describe('retypeStaleMessage', () => {
  it('names the shape', () => {
    expect(retypeStaleMessage('circle')).toContain('circle')
  })
})
