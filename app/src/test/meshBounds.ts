/**
 * meshBounds — a test-only `object_bounds` built from a mocked
 * `object_mesh`: the kernel bounds an object's vertices under a pose, and a
 * mock that already carries positions answers the same way through
 * `meshWorldBounds`, so a scene mock keeps describing parts by their
 * corners.
 */

import { meshWorldBounds } from '../panels/objectBounds'

export function objectBoundsFromMesh(
  objectMesh: (id: bigint) => { positions(): Float32Array; free(): void },
): (id: bigint, pose?: Float64Array) => Float64Array {
  return (id, pose) => {
    const mesh = objectMesh(id)
    try {
      const b = meshWorldBounds(mesh.positions(), pose)
      return b === null ? new Float64Array() : Float64Array.from([...b.min, ...b.max])
    } finally {
      mesh.free()
    }
  }
}
