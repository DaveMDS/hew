import { describe, it, expect, vi } from 'vitest'
import { FacePickCache, cursorOnFrozenPlane, defaultFaceEligible, worldFaceNormal, worldFacePlane } from './faceDraw'
import type { Scene as WasmScene } from '../wasm/loader'
import { setPickRenderMode } from './pickPolicy'
import type { Ray } from '../viewport/math'
import type { V3 } from '../viewport/geoHelpers'

const RAY: Ray = { origin: [0, 0, 5], direction: [0, 0, -1] }

function makePick(object: bigint, face: bigint, instance?: bigint) {
  return {
    object: () => object,
    face: () => face,
    instance: () => instance,
    depth: () => 0,
    free: vi.fn(),
  }
}

/** node_parent(0, id) — `parents` maps a grouped object to its group id. */
function makeWasmScene(opts: {
  pick?: ReturnType<typeof makePick>
  parents?: Map<bigint, bigint>
} = {}): WasmScene {
  return {
    pick_face: vi.fn(() => opts.pick),
    node_parent: vi.fn((_kind: number, id: bigint) => opts.parents?.get(id)),
  } as unknown as WasmScene
}

describe('defaultFaceEligible (plain objects are directly drawable)', () => {
  it('top level: a plain, ungrouped object is eligible', () => {
    const scene = makeWasmScene()
    expect(defaultFaceEligible(scene, null, 7n, undefined)).toBe(true)
  })

  it('top level: an object inside a group needs the explicit edit step', () => {
    const scene = makeWasmScene({ parents: new Map([[7n, 3n]]) })
    expect(defaultFaceEligible(scene, null, 7n, undefined)).toBe(false)
  })

  it('top level: instanced (component) geometry needs the explicit edit step', () => {
    const scene = makeWasmScene()
    expect(defaultFaceEligible(scene, null, 7n, 12n)).toBe(false)
  })

  it('inside an entered object context: only that object, never instanced geometry', () => {
    const scene = makeWasmScene()
    expect(defaultFaceEligible(scene, 7n, 7n, undefined)).toBe(true)
    expect(defaultFaceEligible(scene, 7n, 8n, undefined)).toBe(false)
    expect(defaultFaceEligible(scene, 7n, 7n, 12n)).toBe(false)
  })
})

describe('FacePickCache', () => {
  it('memoizes the pick per Ray reference — one raycast for repeated queries on the same event', () => {
    const scene = makeWasmScene({ pick: makePick(7n, 3n) })
    const cache = new FacePickCache()
    const eligible = () => true

    const first = cache.pickFor(scene, RAY, eligible)
    const second = cache.pickFor(scene, RAY, eligible)
    expect(first).toEqual({ object: 7n, face: 3n })
    expect(second).toEqual(first)
    expect(scene.pick_face).toHaveBeenCalledTimes(1)

    // A NEW ray object re-picks (the Viewport builds one Ray per event).
    cache.pickFor(scene, { ...RAY }, eligible)
    expect(scene.pick_face).toHaveBeenCalledTimes(2)
  })

  it('hands the pick instance to the eligibility predicate and caches a rejection as null', () => {
    const scene = makeWasmScene({ pick: makePick(7n, 3n, 12n) })
    const cache = new FacePickCache()
    const isEligible = vi.fn(() => false)

    expect(cache.pickFor(scene, RAY, isEligible)).toBeNull()
    expect(isEligible).toHaveBeenCalledWith(7n, 12n)
    expect(cache.pickFor(scene, RAY, isEligible)).toBeNull()
    expect(scene.pick_face).toHaveBeenCalledTimes(1)
  })

  it('frees the wasm pick handle', () => {
    const pick = makePick(7n, 3n)
    const scene = makeWasmScene({ pick })
    new FacePickCache().pickFor(scene, RAY, () => true)
    expect(pick.free).toHaveBeenCalledTimes(1)
  })
})

describe('worldFaceNormal (component-edit-parity.md phase A2)', () => {
  function normalScene(local: [number, number, number], pose?: Float64Array): WasmScene {
    return {
      face_normal: vi.fn(() => new Float64Array(local)),
      instance_pose: vi.fn(() => pose),
    } as unknown as WasmScene
  }

  it('with activeInstance null, returns face_normal raw — a world object or Group member (local == world already)', () => {
    const scene = normalScene([0, 0, 1])
    expect(worldFaceNormal(scene, 3n, 4n, null)).toEqual([0, 0, 1])
  })

  it('with an activeInstance, poses the LOCAL normal forward through its pose (rotation)', () => {
    // 90° about Z: +X normal becomes +Y.
    const pose = new Float64Array([0, -1, 0, 5, 1, 0, 0, -2, 0, 0, 1, 9])
    const scene = normalScene([1, 0, 0], pose)
    const n = worldFaceNormal(scene, 3n, 4n, 42n)
    expect(n).not.toBeNull()
    expect(n![0]).toBeCloseTo(0)
    expect(n![1]).toBeCloseTo(1)
    expect(n![2]).toBeCloseTo(0)
  })

  it('maps by the inverse-transpose under a non-uniform scale, not the plain linear part', () => {
    const pose = new Float64Array([2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]) // ×2 in X only
    const local: [number, number, number] = [Math.SQRT1_2, Math.SQRT1_2, 0]
    const scene = normalScene(local, pose)
    const n = worldFaceNormal(scene, 3n, 4n, 42n)
    expect(n).not.toBeNull()
    // The correct inverse-transpose of diag(2,1,1) is diag(0.5,1,1); the
    // WRONG plain-linear-part answer (diag(2,1,1) applied directly) would
    // tilt the other way (toward X, not away from it).
    const correctLen = Math.hypot(0.5, 1, 0)
    expect(n![0]).toBeCloseTo(0.5 / correctLen, 6)
    expect(n![1]).toBeCloseTo(1 / correctLen, 6)
    const wrongLen = Math.hypot(2, 1, 0)
    expect(n![0]).not.toBeCloseTo(2 / wrongLen, 2)
  })

  it('returns null for a stale/unknown instance — never falls back to the raw local normal', () => {
    const scene = normalScene([0, 0, 1], undefined)
    expect(worldFaceNormal(scene, 3n, 4n, 42n)).toBeNull()
  })
})

describe('worldFaceNormal / worldFacePlane on a stale handle (the documented null, not a throw)', () => {
  /** A scene whose face queries refuse like the kernel does for a handle
   *  that names nothing — the state a memoized face pick is left in once a
   *  retype has undone and recommitted the imprint under the cursor. */
  function staleScene(code: string): WasmScene {
    const refuse = () => {
      throw new Error(`${code}: stale or unknown ${code === 'UnknownObject' ? 'object' : 'face'} handle`)
    }
    return { face_normal: vi.fn(refuse), face_plane: vi.fn(refuse), instance_pose: vi.fn(() => undefined) } as unknown as WasmScene
  }

  it.each(['UnknownFace', 'UnknownObject'])('worldFaceNormal answers null when face_normal throws %s', (code) => {
    expect(worldFaceNormal(staleScene(code), 3n, 4n, null)).toBeNull()
  })

  it.each(['UnknownFace', 'UnknownObject'])('worldFacePlane answers null when face_plane throws %s', (code) => {
    const scene = {
      face_normal: vi.fn(() => new Float64Array([0, 0, 1])),
      face_plane: vi.fn(() => { throw new Error(`${code}: stale or unknown handle`) }),
      instance_pose: vi.fn(() => undefined),
    } as unknown as WasmScene
    expect(worldFacePlane(scene, 3n, 4n, null)).toBeNull()
  })

  it('still propagates any other kernel error — only a gone handle is a documented miss', () => {
    const scene = {
      face_normal: vi.fn(() => { throw new Error('Internal: something else entirely') }),
      face_plane: vi.fn(),
      instance_pose: vi.fn(() => undefined),
    } as unknown as WasmScene
    expect(() => worldFaceNormal(scene, 3n, 4n, null)).toThrow('Internal')
    expect(() => worldFacePlane(scene, 3n, 4n, null)).toThrow('Internal')
  })
})

describe('FacePickCache boundary probe', () => {
  const RAY = { origin: [0, 0, 5] as [number, number, number], direction: [0, 0, -1] as [number, number, number] }
  const eligible = () => true
  const sceneMissingOnTheRay = () => {
    const pick_face = vi.fn((_ox: number, _oy: number, _oz: number, dx: number, dy: number, dz: number) =>
      dx === 0 && dy === 0 && dz === -1
        ? undefined // exactly on the edge: a strict miss
        : { object: () => 7n, instance: () => undefined, face: () => 3n, free: vi.fn() },
    )
    return { scene: { pick_face } as unknown as Parameters<FacePickCache['pickFor']>[0], pick_face }
  }

  it('does not probe unless asked, and a miss costs one raycast', () => {
    const { scene, pick_face } = sceneMissingOnTheRay()
    const cache = new FacePickCache()
    expect(cache.pickFor(scene, RAY, eligible)).toBeNull()
    expect(pick_face).toHaveBeenCalledTimes(1)
  })
})

describe('FacePickCache.faceThrough (boundary-click face resolution)', () => {
  const RAY = { origin: [0, 0, 5] as [number, number, number], direction: [0, 0, -1] as [number, number, number] }
  const eligible = () => true

  /** A fake scene whose `pick_face` misses on the exact ray direction (a
   *  boundary click — the strict polygon test misses both faces meeting
   *  there) but returns `hit` for every nudged ring probe direction, and
   *  whose `face_plane`/`face_normal` answer per the given `planes` map
   *  (keyed `object:face`). */
  function makeScene(
    hit: { object: bigint; face: bigint } | ((callIndex: number) => { object: bigint; face: bigint } | undefined),
    planes: Map<string, { point: V3; normal: V3 }>,
  ) {
    let callIndex = 0
    const pick_face = vi.fn((_ox: number, _oy: number, _oz: number, dx: number, dy: number, dz: number) => {
      const isBaseRay = dx === 0 && dy === 0 && dz === -1
      const idx = callIndex++
      if (isBaseRay) return undefined // exactly on the edge: a strict miss
      const picked = typeof hit === 'function' ? hit(idx) : hit
      if (picked === undefined) return undefined
      return { object: () => picked.object, instance: () => undefined, face: () => picked.face, depth: () => 0, free: vi.fn() }
    })
    const face_normal = vi.fn((object: bigint, face: bigint) => {
      const p = planes.get(`${object}:${face}`)
      if (p === undefined) throw new Error(`no plane for ${object}:${face}`)
      return new Float64Array(p.normal)
    })
    const face_plane = vi.fn((object: bigint, face: bigint) => {
      const p = planes.get(`${object}:${face}`)
      if (p === undefined) throw new Error(`no plane for ${object}:${face}`)
      return new Float64Array([...p.point, ...p.normal])
    })
    return { pick_face, face_normal, face_plane } as unknown as WasmScene
  }

  it('a miss on the exact ray, a ring hit whose plane contains the through point, is returned', () => {
    const scene = makeScene(
      { object: 7n, face: 3n },
      new Map([['7:3', { point: [0, 0, 0], normal: [0, 0, 1] }]]),
    )
    const cache = new FacePickCache()
    const result = cache.faceThrough(scene, RAY, eligible, null, [[0, 0, 0]])
    expect(result).toEqual({ object: 7n, face: 3n, point: [0, 0, 0], normal: [0, 0, 1] })
  })

  it('a ring hit whose plane does NOT contain the through point is rejected', () => {
    const scene = makeScene(
      { object: 7n, face: 3n },
      new Map([['7:3', { point: [0, 0, 0], normal: [0, 0, 1] }]]),
    )
    const cache = new FacePickCache()
    // The through point sits 5m off the z=0 plane the only candidate lives on.
    const result = cache.faceThrough(scene, RAY, eligible, null, [[0, 0, 5]])
    expect(result).toBeNull()
  })

  it('two candidates through the point: the more camera-facing one wins', () => {
    // Object 10/face 1: a vertical plane through the origin (normal +X) —
    // facing the ray [0,0,-1] edge-on (facing score 0). Object 20/face 2: a
    // horizontal plane through the origin (normal +Z) — facing the camera
    // dead-on (facing score 1, since -ray.direction is +Z). Both planes pass
    // through the origin, so the through point [0,0,0] lies on both.
    const planes = new Map([
      ['10:1', { point: [0, 0, 0] as V3, normal: [1, 0, 0] as V3 }],
      ['20:2', { point: [0, 0, 0] as V3, normal: [0, 0, 1] as V3 }],
    ])
    const scene = makeScene((idx) => (idx === 1 ? { object: 10n, face: 1n } : { object: 20n, face: 2n }), planes)
    const cache = new FacePickCache()
    const result = cache.faceThrough(scene, RAY, eligible, null, [[0, 0, 0]])
    expect(result).toEqual({ object: 20n, face: 2n, point: [0, 0, 0], normal: [0, 0, 1] })
  })

  it('X-ray: a point hidden behind a nearer face still finds the face it lies on; Wireframe adopts no face', () => {
    // `pick_face` sees only the face in front (z = 1, which does not hold
    // the point at z = 0) — or nothing at all in Wireframe. In X-ray the
    // geometry pick, started just short of the point, reaches the face under
    // it; in Wireframe faces are no input, so nothing is adopted.
    const planes = new Map([
      ['1:1', { point: [0, 0, 1] as V3, normal: [0, 0, 1] as V3 }],
      ['2:2', { point: [0, 0, 0] as V3, normal: [0, 0, 1] as V3 }],
    ])
    const sceneWith = (front: { object: bigint; face: bigint } | undefined) => {
      const scene = makeScene(() => front, planes) as unknown as Record<string, unknown>
      const origins: number[] = []
      scene.pick_face_geometry = vi.fn((_ox: number, _oy: number, oz: number) => {
        origins.push(oz)
        // Started past the front face: the face holding the point.
        return oz < 1
          ? { object: () => 2n, instance: () => undefined, face: () => 2n, depth: () => 0, free: vi.fn() }
          : { object: () => 1n, instance: () => undefined, face: () => 1n, depth: () => 0, free: vi.fn() }
      })
      return { scene: scene as unknown as WasmScene, origins }
    }
    try {
      setPickRenderMode('xray')
      const { scene, origins } = sceneWith({ object: 1n, face: 1n })
      const result = new FacePickCache().faceThrough(scene, RAY, eligible, null, [[0, 0.001, 0]])
      expect(result).toMatchObject({ object: 2n, face: 2n, normal: [0, 0, 1] })
      // Every fallback probe starts 2% short of the point, past the z = 1 face.
      expect(origins.length).toBeGreaterThan(0)
      for (const oz of origins) expect(oz).toBeCloseTo(0.1, 2)

      setPickRenderMode('wireframe')
      const wire = sceneWith(undefined)
      expect(new FacePickCache().faceThrough(wire.scene, RAY, eligible, null, [[0, 0.001, 0]])).toBeNull()
      expect(wire.origins).toHaveLength(0)
    } finally {
      setPickRenderMode('shaded')
    }
  })

  it('a pick memoized for a ray is not served after a render-mode switch', () => {
    const planes = new Map([['7:3', { point: [0, 0, 0] as V3, normal: [0, 0, 1] as V3 }]])
    let hit: { object: bigint; face: bigint } | undefined = { object: 7n, face: 3n }
    const scene = makeScene(() => hit, planes) as unknown as Record<string, unknown>
    // The plain pick answers the exact ray too here.
    scene.pick_face = vi.fn(() =>
      hit && { object: () => hit!.object, instance: () => undefined, face: () => hit!.face, depth: () => 1, free: vi.fn() },
    )
    const cache = new FacePickCache()
    try {
      expect(cache.pickFor(scene as unknown as WasmScene, RAY, eligible)).toEqual({ object: 7n, face: 3n })
      // Wireframe: the kernel picks no face for the same held ray.
      hit = undefined
      expect(cache.pickFor(scene as unknown as WasmScene, RAY, eligible), 'same mode: memoized').toEqual({ object: 7n, face: 3n })
      setPickRenderMode('wireframe')
      expect(cache.pickFor(scene as unknown as WasmScene, RAY, eligible), 'after the switch: picked afresh').toBeNull()
      expect(cache.faceThrough(scene as unknown as WasmScene, RAY, eligible, null, [[0, 0, 0]])).toBeNull()
    } finally {
      setPickRenderMode('shaded')
    }
  })

  it('a visible point never takes the geometry fallback', () => {
    const planes = new Map([['7:3', { point: [0, 0, 0] as V3, normal: [0, 0, 1] as V3 }]])
    const scene = makeScene({ object: 7n, face: 3n }, planes) as unknown as Record<string, unknown>
    scene.pick_face_geometry = vi.fn()
    new FacePickCache().faceThrough(scene as unknown as WasmScene, RAY, eligible, null, [[0, 0, 0]])
    expect(scene.pick_face_geometry).not.toHaveBeenCalled()
  })
})

describe('cursorOnFrozenPlane (a frozen draw plane meeting an off-plane snap)', () => {
  const ray = { origin: [0.2, 0.3, 5] as V3, direction: [0, 0, -1] as V3 }
  const snap = (x: number, y: number, z: number) => ({ x, y, z, kind: 'midpoint' }) as unknown as Parameters<typeof cursorOnFrozenPlane>[0]

  it('takes an on-plane snap exactly, not projected', () => {
    expect(cursorOnFrozenPlane(snap(1, 2, 1), ray, [0, 0, 1], [0, 0, 1])).toEqual({ point: [1, 2, 1], projected: false })
  })

  it('drops an off-plane snap (hidden geometry offered in X-ray) straight onto the plane, disclosed', () => {
    const at = cursorOnFrozenPlane(snap(1, 0.7, 0.6), ray, [0, 0, 1], [0, 0, 1])
    expect(at?.projected).toBe(true)
    expect(at?.point[0]).toBeCloseTo(1)
    expect(at?.point[1]).toBeCloseTo(0.7)
    expect(at?.point[2]).toBeCloseTo(1)
    // A tilted plane: the drop runs along its normal.
    const n: V3 = [0, Math.SQRT1_2, Math.SQRT1_2]
    const tilted = cursorOnFrozenPlane(snap(0, 1, 1), ray, [0, 0, 0], n)
    expect(tilted?.projected).toBe(true)
    expect(Math.abs(tilted!.point[1] * n[1] + tilted!.point[2] * n[2])).toBeLessThan(1e-12)
  })

  it('with no snap, the ray hit; parallel rays miss', () => {
    expect(cursorOnFrozenPlane(null, ray, [0, 0, 1], [0, 0, 1])).toEqual({ point: [0.2, 0.3, 1], projected: false })
    expect(cursorOnFrozenPlane(null, ray, [0, 0, 0], [1, 0, 0])).toBeNull()
  })
})
