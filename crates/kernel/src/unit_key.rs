//! Geometry-derived keys for sketch units (islands, curves, edges, regions).
//!
//! A sketch handle ([`SketchEdgeId`] and friends) is minted from slot
//! history, so it does not survive a save/load, a re-facet, or a replay
//! that rebuilds the sketch. A *unit key* is a 64-bit FNV-1a hash of the
//! geometry the unit is made of, computed in the sketch plane's `(u, v)`
//! coordinates from the positions exactly as stored (the f64 bit patterns,
//! never rounded; only the axes come from a quantized normal, so one plane
//! reached two ways keys alike). A key therefore stays the same until the geometry it
//! hashes changes — the same stability islands have today — and two
//! sessions that hold the same drawing agree on every key.
//!
//! - **edge key**: the two endpoints' `(u, v)` bits, the lexicographically
//!   smaller endpoint first, so direction does not matter.
//! - **island key**: the minimum edge key in the island.
//! - **curve key**: the analytic circle's `(center u, center v, radius)` bits;
//!   a regular polygon's key also takes its corners (its vertices on the
//!   circumcircle, sorted), so two polygons inscribed in one circle key
//!   apart ([`chain_key`]).
//! - **region key**: FNV-1a 64 over the sorted edge keys of the region's
//!   outer ring — every edge counts, so two regions sharing an edge (a shape
//!   flush to a face's corner and the face around it) never collide.
//!
//! Everything here is pure and deterministic; maps are `BTreeMap`s.

use std::collections::BTreeMap;

use crate::geom2d::plane_axes;
use crate::math::{Plane, Point3};
use crate::sketch::{
    Sketch, SketchCurveId, SketchCurveKind, SketchEdgeId, SketchIslandId, SketchRegionId,
    SketchVertexId,
};

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

fn fnv1a(words: &[f64]) -> u64 {
    let mut h = FNV_OFFSET;
    for w in words {
        for byte in w.to_bits().to_le_bytes() {
            h ^= u64::from(byte);
            h = h.wrapping_mul(FNV_PRIME);
        }
    }
    h
}

/// The plane's `(u, v)` axes, from its normal quantized to a 2^-40 grid: the
/// same plane reached two ways (a face's stored plane, the plane a caller
/// rebuilt from its numbers) can differ in a normal's last bits, and the
/// keys must not. Positions themselves are never rounded.
fn key_axes(plane: &Plane) -> (crate::math::Vec3, crate::math::Vec3) {
    const GRID: f64 = 1_099_511_627_776.0; // 2^40
    // `+ 0.0` folds -0.0 into 0.0 so the axes' bits cannot depend on it.
    let q = |x: f64| (x * GRID).round() / GRID + 0.0;
    let n = plane.normal();
    plane_axes(crate::math::Vec3::new(q(n.x), q(n.y), q(n.z)))
}

fn uv(plane: &Plane, p: Point3) -> (f64, f64) {
    let (u, v) = key_axes(plane);
    (p.to_vec().dot(u), p.to_vec().dot(v))
}

/// Lexicographic order on `(u, v)` by exact value, falling back to the bit
/// pattern so the order is total (no NaN ambiguity, `-0.0` before `0.0`).
fn uv_less(a: (f64, f64), b: (f64, f64)) -> bool {
    match a.0.total_cmp(&b.0) {
        std::cmp::Ordering::Less => true,
        std::cmp::Ordering::Greater => false,
        std::cmp::Ordering::Equal => a.1.total_cmp(&b.1).is_lt(),
    }
}

/// The key of the segment `a`–`b` on `plane`: FNV-1a 64 over the endpoints'
/// `(u, v)` bit patterns, the lexicographically smaller endpoint first.
/// Direction-independent.
pub fn edge_key(plane: &Plane, a: Point3, b: Point3) -> u64 {
    let pa = uv(plane, a);
    let pb = uv(plane, b);
    let (lo, hi) = if uv_less(pb, pa) { (pb, pa) } else { (pa, pb) };
    fnv1a(&[lo.0, lo.1, hi.0, hi.1])
}

/// The key of a circle on `plane`: FNV-1a 64 over `(center u, center v,
/// radius)` bit patterns.
pub fn curve_key(plane: &Plane, center: Point3, radius: f64) -> u64 {
    let c = uv(plane, center);
    fnv1a(&[c.0, c.1, radius])
}

/// The key of curve chain `c` of `sk`: [`curve_key`] of its circle, and for
/// a regular polygon its corners too (the chain's vertices on the
/// circumcircle, by `(u, v)`), since the circumcircle alone is shared by
/// every polygon inscribed in it. `None` for a chain with no edges left.
pub fn chain_key(sk: &Sketch, c: SketchCurveId) -> Option<u64> {
    let plane = sk.plane();
    let a = sk.curve_analytic(c)?;
    let g = a.geom;
    if a.kind != SketchCurveKind::Polygon {
        return Some(curve_key(&plane, g.center, g.radius));
    }
    let near = crate::tol::PLANE_DIST.max(g.radius * 1e-7);
    let mut ids: Vec<SketchVertexId> = sk
        .edges()
        .values()
        .filter(|e| e.curve == Some(c))
        .flat_map(|e| [e.from, e.to])
        .collect();
    ids.sort_unstable();
    ids.dedup();
    let mut corners: Vec<(f64, f64)> = ids
        .into_iter()
        .filter_map(|v| sk.vertices().get(v).map(|x| x.position))
        .filter(|&q| ((q - g.center).length() - g.radius).abs() <= near)
        .map(|q| uv(&plane, q))
        .collect();
    corners.sort_by(|x, y| {
        if uv_less(*x, *y) {
            std::cmp::Ordering::Less
        } else if uv_less(*y, *x) {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Equal
        }
    });
    let c0 = uv(&plane, g.center);
    let mut words = vec![c0.0, c0.1, g.radius];
    for (u, v) in corners {
        words.push(u);
        words.push(v);
    }
    Some(fnv1a(&words))
}

/// The key of a region whose outer ring has the edges keyed `ring`: FNV-1a 64
/// over those keys, sorted (so the ring's start and direction do not
/// matter). Two distinct regions never share an outer ring, so never a key.
pub fn region_key(ring: impl IntoIterator<Item = u64>) -> u64 {
    let mut keys: Vec<u64> = ring.into_iter().collect();
    keys.sort_unstable();
    let mut h = FNV_OFFSET;
    for k in keys {
        for byte in k.to_le_bytes() {
            h ^= u64::from(byte);
            h = h.wrapping_mul(FNV_PRIME);
        }
    }
    h
}

/// Every unit key of one sketch. See the module docs for the definitions.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SketchUnitKeys {
    /// Key of each edge.
    pub edges: BTreeMap<SketchEdgeId, u64>,
    /// Key of each island: the minimum edge key it contains.
    pub islands: BTreeMap<SketchIslandId, u64>,
    /// Key of each curve chain that carries analytic geometry.
    pub curves: BTreeMap<SketchCurveId, u64>,
    /// Key of each region ([`region_key`] of its outer ring).
    pub regions: BTreeMap<SketchRegionId, u64>,
}

impl Sketch {
    /// The geometry keys of every edge, island, analytic curve, and region
    /// of this sketch (design: unit keys). Pure; computed on demand.
    pub fn unit_keys(&self) -> SketchUnitKeys {
        let plane = self.plane();
        let mut out = SketchUnitKeys::default();

        let mut by_pair: BTreeMap<(SketchVertexId, SketchVertexId), u64> = BTreeMap::new();
        for (id, e) in self.edges().iter() {
            let (Some(a), Some(b)) = (self.vertices().get(e.from), self.vertices().get(e.to))
            else {
                continue;
            };
            let key = edge_key(&plane, a.position, b.position);
            out.edges.insert(id, key);
            by_pair.insert((e.from.min(e.to), e.from.max(e.to)), key);
        }

        for (id, isl) in self.islands().iter() {
            if let Some(min) = isl.edges.iter().filter_map(|e| out.edges.get(e)).min() {
                out.islands.insert(id, *min);
            }
        }

        // A chain is live exactly while some edge carries its id.
        let live: std::collections::BTreeSet<SketchCurveId> =
            self.edges().values().filter_map(|e| e.curve).collect();
        for id in live {
            if let Some(k) = chain_key(self, id) {
                out.curves.insert(id, k);
            }
        }

        for (id, r) in self.regions().iter() {
            let n = r.outer.len();
            let ring: Option<Vec<u64>> = (0..n)
                .map(|i| {
                    let a = r.outer[i];
                    let b = r.outer[(i + 1) % n];
                    by_pair.get(&(a.min(b), a.max(b))).copied()
                })
                .collect();
            if let Some(ring) = ring.filter(|r| !r.is_empty()) {
                out.regions.insert(id, region_key(ring));
            }
        }
        out
    }
}
