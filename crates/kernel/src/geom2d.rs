//! Crate-internal 2-D geometry helpers (point-in-polygon, plane axes).
//!
//! These are used by both `sketch` (profile validation) and `ops` (hole
//! reassignment during `split_face`).  Nothing here is public API.

use crate::math::{Point3, Vec3};
use crate::tol;

/// Returns two orthonormal vectors (u, v) that span the plane with the given
/// normal.  The result is stable for any non-zero normal.
pub(crate) fn plane_axes(normal: Vec3) -> (Vec3, Vec3) {
    // Choose a reference vector not parallel to normal.
    let reference = if normal.x.abs() <= normal.y.abs() && normal.x.abs() <= normal.z.abs() {
        Vec3::new(1.0, 0.0, 0.0)
    } else if normal.y.abs() <= normal.z.abs() {
        Vec3::new(0.0, 1.0, 0.0)
    } else {
        Vec3::new(0.0, 0.0, 1.0)
    };
    let u = normal
        .cross(reference)
        .normalized()
        .expect("plane_axes: normal is non-zero");
    let v = normal
        .cross(u)
        .normalized()
        .expect("plane_axes: u is non-zero");
    (u, v)
}

/// Signed area of a polygon against the given normal, using the 2-D cross
/// product projected onto the plane.  Positive = CCW seen from the normal
/// side.
pub(crate) fn signed_area_on_plane(pts: &[Point3], normal: Vec3) -> f64 {
    let (u, v) = plane_axes(normal);
    let n = pts.len();
    let mut area = 0.0;
    for i in 0..n {
        let a = pts[i];
        let b = pts[(i + 1) % n];
        let ax = a.to_vec().dot(u);
        let ay = a.to_vec().dot(v);
        let bx = b.to_vec().dot(u);
        let by = b.to_vec().dot(v);
        area += ax * by - bx * ay;
    }
    area * 0.5
}

/// Point-in-polygon test using the ray-casting method projected onto the
/// plane spanned by `normal`. Returns `true` only for strictly interior
/// points; boundary points return `false` (strict interior required for
/// `HoleOutsideOuter`).
pub(crate) fn point_inside_polygon(pt: Point3, poly: &[Point3], normal: Vec3) -> bool {
    let (u, v) = plane_axes(normal);
    let px = pt.to_vec().dot(u);
    let py = pt.to_vec().dot(v);

    let n = poly.len();
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let ai_x = poly[i].to_vec().dot(u);
        let ai_y = poly[i].to_vec().dot(v);
        let aj_x = poly[j].to_vec().dot(u);
        let aj_y = poly[j].to_vec().dot(v);

        if ((ai_y > py) != (aj_y > py)) && (px < (aj_x - ai_x) * (py - ai_y) / (aj_y - ai_y) + ai_x)
        {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Whether two segments cross at a single interior point of both — a
/// PROPER crossing: touching at an endpoint, sharing a point of one with the
/// interior of the other, or lying along each other all answer false.
pub(crate) fn segments_cross_properly(p: Point3, q: Point3, r: Point3, s: Point3) -> bool {
    let eps = tol::POINT_MERGE;
    // The four orientation cross products of coplanar points all lie along
    // the plane's normal; each is measured along ONE common axis (the
    // longest of them), so their signs compare. (Taking each one's own
    // dominant component flips signs on a face whose normal splits evenly
    // between two axes.)
    let c = [
        (s - r).cross(p - r),
        (s - r).cross(q - r),
        (q - p).cross(r - p),
        (q - p).cross(s - p),
    ];
    let axis = c
        .iter()
        .copied()
        .max_by(|a, b| a.length_squared().total_cmp(&b.length_squared()))
        .expect("four products");
    let Ok(n) = axis.normalized() else {
        return false; // all four ends on one line: no proper crossing
    };
    let [d1, d2, d3, d4] = c.map(|v| v.dot(n));
    ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps))
        && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))
}

/// Whether segments `p–q` and `r–s` (coplanar) share a point: they cross,
/// or an end of one lies within [`tol::POINT_MERGE`] of the other (an end
/// touching, or the two running along each other).
///
/// A crossing is decided EXACTLY, with no tolerance: the four orientation
/// signs (each end against the other segment's line) are computed by an
/// adaptive exact predicate, so a proper crossing is never missed however
/// close to an end it falls — at kilometre coordinates, an acute crossing
/// a nanometre from an end of each segment once read as no contact, every
/// end being just over the tolerance from the other segment's body. Every
/// other contact is METRIC — a distance in metres against `POINT_MERGE`,
/// the tolerance every other contact gate in the kernel uses — so nothing
/// is reported that is neither a crossing nor a touch.
pub(crate) fn segments_intersect(p: Point3, q: Point3, r: Point3, s: Point3) -> bool {
    let eps = tol::POINT_MERGE;
    if point_near_segment(p, r, s, eps)
        || point_near_segment(q, r, s, eps)
        || point_near_segment(r, p, q, eps)
        || point_near_segment(s, p, q, eps)
    {
        return true;
    }
    segments_cross_exactly(p, q, r, s)
}

/// Whether coplanar segments `p–q` and `r–s` cross at a point interior to
/// both, decided by exact orientation signs in the plane's projection onto
/// the two world axes its normal is least aligned with. Four points lying
/// along one line to rounding have no plane to project into: no crossing
/// (any contact between such segments is an end within rounding of the
/// other's line, which the distance tests see).
fn segments_cross_exactly(p: Point3, q: Point3, r: Point3, s: Point3) -> bool {
    let (pq, rs) = (q - p, s - r);
    let normal = [pq.cross(rs), pq.cross(r - p), rs.cross(p - r)]
        .into_iter()
        .max_by(|a, b| a.length_squared().total_cmp(&b.length_squared()))
        .expect("three candidates");
    let reach = pq.length() + rs.length() + (r - p).length();
    if normal.length() <= COLLINEAR_FLOOR * reach * reach {
        return false;
    }
    let (ax, ay) = match (normal.x.abs(), normal.y.abs(), normal.z.abs()) {
        (x, y, z) if z >= x && z >= y => (0, 1),
        (x, y, _) if y >= x => (2, 0),
        _ => (1, 2),
    };
    let at = |pt: Point3, k: usize| match k {
        0 => pt.x,
        1 => pt.y,
        _ => pt.z,
    };
    let o = |a: Point3, b: Point3, c: Point3| {
        orient2d(
            (at(a, ax), at(a, ay)),
            (at(b, ax), at(b, ay)),
            (at(c, ax), at(c, ay)),
        )
    };
    o(r, s, p) * o(r, s, q) < 0 && o(p, q, r) * o(p, q, s) < 0
}

/// Below this many units of rounding (relative to the squared extent of
/// the points), a normal estimate is rounding noise: the points lie along
/// one line. An arithmetic bound, not a geometric tolerance.
const COLLINEAR_FLOOR: f64 = 64.0 * f64::EPSILON;

/// Shewchuk's first error bound for the 2-D orientation determinant:
/// `(3 + 16ε)ε` with `ε = 2⁻⁵³`. A float determinant larger than this
/// times its two products' magnitudes has the exact sign.
const ORIENT_ERR_BOUND: f64 = (3.0 + 8.0 * f64::EPSILON) * (f64::EPSILON / 2.0);

/// The exact sign (+1 counter-clockwise, −1 clockwise, 0 collinear) of
/// `(b − a) × (c − a)`: a floating-point evaluation when its error bound
/// proves the sign, else an exact expansion (every difference and product
/// kept as an unevaluated sum of doubles).
pub(crate) fn orient2d(a: (f64, f64), b: (f64, f64), c: (f64, f64)) -> i32 {
    let left = (b.0 - a.0) * (c.1 - a.1);
    let right = (b.1 - a.1) * (c.0 - a.0);
    let det = left - right;
    if det.abs() > ORIENT_ERR_BOUND * (left.abs() + right.abs()) {
        return if det > 0.0 { 1 } else { -1 };
    }
    let (abx, abx_e) = two_sum(b.0, -a.0);
    let (aby, aby_e) = two_sum(b.1, -a.1);
    let (acx, acx_e) = two_sum(c.0, -a.0);
    let (acy, acy_e) = two_sum(c.1, -a.1);
    let mut e: Vec<f64> = Vec::with_capacity(16);
    for (u, v, sign) in [
        (abx, acy, 1.0),
        (abx, acy_e, 1.0),
        (abx_e, acy, 1.0),
        (abx_e, acy_e, 1.0),
        (aby, acx, -1.0),
        (aby, acx_e, -1.0),
        (aby_e, acx, -1.0),
        (aby_e, acx_e, -1.0),
    ] {
        let (prod, err) = two_product(u, v);
        grow_expansion(&mut e, sign * err);
        grow_expansion(&mut e, sign * prod);
    }
    match e.iter().rev().find(|&&x| x != 0.0) {
        Some(&x) if x > 0.0 => 1,
        Some(_) => -1,
        None => 0,
    }
}

/// `a + b` as an exact two-term sum `(rounded, error)`.
fn two_sum(a: f64, b: f64) -> (f64, f64) {
    let s = a + b;
    let bv = s - a;
    let av = s - bv;
    (s, (a - av) + (b - bv))
}

/// `a · b` as an exact two-term product `(rounded, error)`.
fn two_product(a: f64, b: f64) -> (f64, f64) {
    let p = a * b;
    (p, a.mul_add(b, -p))
}

/// Adds `b` to the nonoverlapping expansion `e` exactly (components in
/// increasing magnitude; the last nonzero one carries the sign).
fn grow_expansion(e: &mut Vec<f64>, b: f64) {
    let mut q = b;
    for x in e.iter_mut() {
        let (sum, err) = two_sum(q, *x);
        *x = err;
        q = sum;
    }
    e.push(q);
}

/// True if `p` lies within `tol` of the closed segment `[a, b]`.
pub(crate) fn point_near_segment(p: Point3, a: Point3, b: Point3, tol: f64) -> bool {
    let ab = b - a;
    let len_sq = ab.length_squared();
    let t = if len_sq <= tol * tol {
        0.0
    } else {
        ((p - a).dot(ab) / len_sq).clamp(0.0, 1.0)
    };
    (p - (a + ab * t)).length_squared() <= tol * tol
}

/// A point strictly inside the material of a polygon-with-holes (inside
/// `outer`, outside every hole), or `None` for degenerate loops.
///
/// Scanline method: pick the plane-axis-horizontal line whose ordinate is the
/// midpoint of the widest gap between distinct vertex ordinates (maximally
/// far from every vertex, so no edge is grazed), intersect it with every loop
/// edge, and take the midpoint of the widest inside interval under the
/// even-odd rule. Deterministic, and works for concave outers and any hole
/// arrangement — unlike a centroid, which can land outside or in a hole.
pub(crate) fn interior_point_of_loops(
    outer: &[Point3],
    holes: &[Vec<Point3>],
    normal: Vec3,
) -> Option<Point3> {
    if outer.len() < 3 {
        return None;
    }
    let (u, v) = plane_axes(normal);
    let px = |p: Point3| p.to_vec().dot(u);
    let py = |p: Point3| p.to_vec().dot(v);
    // {u, v, normal} is orthonormal, so a point on the plane reconstructs
    // exactly from its three projections; the normal component is shared by
    // every loop point.
    let w = outer[0].to_vec().dot(normal);

    let mut ys: Vec<f64> = outer.iter().map(|&p| py(p)).collect();
    let outer_min = ys.iter().copied().fold(f64::INFINITY, f64::min);
    let outer_max = ys.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    for h in holes {
        ys.extend(h.iter().map(|&p| py(p)));
    }
    ys.sort_by(f64::total_cmp);
    ys.dedup_by(|a, b| (*a - *b).abs() <= tol::POINT_MERGE);

    // Vertex-free ordinate bands, clamped to the outer loop's range so the
    // scanline is guaranteed to cross it, widest first: the widest band can
    // lie wholly inside a hole that spans the loop (an enclosed imprint
    // flush with two of its sides), so the next is tried until a scanline
    // finds material.
    let mut bands: Vec<(f64, f64)> = Vec::new(); // (gap, midpoint)
    for pair in ys.windows(2) {
        let (lo, hi) = (pair[0].max(outer_min), pair[1].min(outer_max));
        let gap = hi - lo;
        if gap > tol::POINT_MERGE {
            bands.push((gap, (lo + hi) * 0.5));
        }
    }
    // Widest first; equal gaps keep their ordinate order (stable sort).
    bands.sort_by(|a, b| b.0.total_cmp(&a.0));
    bands.into_iter().find_map(|(_, y_star)| {
        // Every crossing of the scanline with every loop edge, in plane-x.
        let mut xs: Vec<f64> = Vec::new();
        let mut collect = |lp: &[Point3]| {
            let n = lp.len();
            for i in 0..n {
                let (a, b) = (lp[i], lp[(i + 1) % n]);
                let (ax, ay) = (px(a), py(a));
                let (bx, by) = (px(b), py(b));
                if (ay > y_star) != (by > y_star) {
                    xs.push(ax + (bx - ax) * (y_star - ay) / (by - ay));
                }
            }
        };
        collect(outer);
        for h in holes {
            collect(h);
        }
        if xs.len() < 2 {
            return None;
        }
        xs.sort_by(f64::total_cmp);

        // Even-odd: intervals (xs[0], xs[1]), (xs[2], xs[3]), … are material.
        let mut best: Option<(f64, f64)> = None; // (width, midpoint)
        for pair in xs.chunks_exact(2) {
            let width = pair[1] - pair[0];
            if width > tol::POINT_MERGE && best.is_none_or(|(g, _)| width > g) {
                best = Some((width, (pair[0] + pair[1]) * 0.5));
            }
        }
        let (_, x_star) = best?;
        Some(Point3::ORIGIN + u * x_star + v * y_star + normal * w)
    })
}

/// Check whether two separate polygons share any point, cross, or touch.
pub(crate) fn boundaries_contact(a: &[Point3], b: &[Point3]) -> bool {
    let na = a.len();
    let nb = b.len();
    for i in 0..na {
        let p = a[i];
        let q = a[(i + 1) % na];
        for j in 0..nb {
            let r = b[j];
            let s = b[(j + 1) % nb];
            if segments_intersect(p, q, r, s) {
                return true;
            }
        }
    }
    false
}

/// Check that a polygon does not cross or touch itself.  Tests every pair of
/// non-adjacent edges for intersection.
pub(crate) fn polygon_is_simple(pts: &[Point3]) -> bool {
    let n = pts.len();
    for i in 0..n {
        let a = pts[i];
        let b = pts[(i + 1) % n];
        // Skip edges that share a vertex with edge i.
        for j in (i + 2)..n {
            if i == 0 && j == n - 1 {
                continue; // edges 0 and n-1 share vertex 0
            }
            let c = pts[j];
            let d = pts[(j + 1) % n];
            if segments_intersect(a, b, c, d) {
                return false;
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use std::f64::consts::PI;

    /// `a + b` as an exact two-term sum.
    fn two_sum(a: f64, b: f64) -> (f64, f64) {
        let s = a + b;
        let bv = s - a;
        let av = s - bv;
        (s, (a - av) + (b - bv))
    }

    /// `a * b` as an exact two-term product.
    fn two_product(a: f64, b: f64) -> (f64, f64) {
        let p = a * b;
        (p, a.mul_add(b, -p))
    }

    /// Adds `b` to the nonoverlapping expansion `e` exactly (Shewchuk's
    /// grow-expansion).
    fn grow(e: &[f64], b: f64) -> Vec<f64> {
        let mut q = b;
        let mut out = Vec::with_capacity(e.len() + 1);
        for &x in e {
            let (s, err) = two_sum(q, x);
            out.push(err);
            q = s;
        }
        out.push(q);
        out
    }

    /// The exact sign of the 2-D orientation `(b − a) × (c − a)` (z = 0
    /// inputs): every difference and product is kept as an exact expansion.
    fn exact_orient(a: Point3, b: Point3, c: Point3) -> i32 {
        let diff = |x: f64, y: f64| two_sum(x, -y);
        let (abx, abx_e) = diff(b.x, a.x);
        let (aby, aby_e) = diff(b.y, a.y);
        let (acx, acx_e) = diff(c.x, a.x);
        let (acy, acy_e) = diff(c.y, a.y);
        let mut e: Vec<f64> = Vec::new();
        for (u, v, sign) in [
            (abx, acy, 1.0),
            (abx, acy_e, 1.0),
            (abx_e, acy, 1.0),
            (abx_e, acy_e, 1.0),
            (aby, acx, -1.0),
            (aby, acx_e, -1.0),
            (aby_e, acx, -1.0),
            (aby_e, acx_e, -1.0),
        ] {
            let (p, perr) = two_product(u, v);
            e = grow(&e, sign * perr);
            e = grow(&e, sign * p);
        }
        match e.iter().rev().find(|&&x| x != 0.0) {
            Some(&x) if x > 0.0 => 1,
            Some(_) => -1,
            None => 0,
        }
    }

    /// Exact reference: a proper crossing by exact orientation signs, or an
    /// endpoint within `POINT_MERGE` of the other segment.
    fn reference(p: Point3, q: Point3, r: Point3, s: Point3) -> bool {
        let proper = exact_orient(r, s, p) * exact_orient(r, s, q) < 0
            && exact_orient(p, q, r) * exact_orient(p, q, s) < 0;
        let m = tol::POINT_MERGE;
        proper
            || point_near_segment(p, r, s, m)
            || point_near_segment(q, r, s, m)
            || point_near_segment(r, p, q, m)
            || point_near_segment(s, p, q, m)
    }

    /// Proper crossings at 2–4 km within nanometres of an end of each
    /// segment, every end more than `POINT_MERGE` from the other segment:
    /// once read as no contact at all (a fuzz of 3 million such pairs).
    #[test]
    fn crossings_near_both_ends_far_from_the_origin_are_contacts() {
        let pt = |x: f64, y: f64| Point3::new(x, y, 0.0);
        let cases = [
            [
                pt(3526.0952849980645, 2468.43609094126),
                pt(3526.1192999042596, 2468.2835099329814),
                pt(3526.0856694564486, 2468.356381010453),
                pt(3526.1192999057585, 2468.28350993212),
            ],
            [
                pt(3705.319407149622, 2492.0640208240848),
                pt(3732.8821521849077, 2613.017506529435),
                pt(3790.8912924388733, 2466.1224924391518),
                pt(3732.88215218381, 2613.0175065291187),
            ],
            [
                pt(3927.5478617999415, 2742.9636127014583),
                pt(3917.233113590398, 2742.063179513278),
                pt(3919.774483388066, 2743.937489396721),
                pt(3917.2331135919044, 2742.063179512406),
            ],
            [
                pt(3358.0863456321754, 2350.518000812669),
                pt(3357.9526526662385, 2350.566856866367),
                pt(3358.0426655272045, 2350.5918940701404),
                pt(3357.9526526649247, 2350.5668568649635),
            ],
        ];
        for [p, q, r, s] in cases {
            assert!(reference(p, q, r, s), "the reference sees the crossing");
            assert!(segments_intersect(p, q, r, s), "{p:?} {q:?} / {r:?} {s:?}");
            assert!(segments_intersect(r, s, p, q), "symmetric");
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(20000))]

        /// `segments_intersect` agrees with the exact reference on
        /// near-parallel, T, and acute near-endpoint pairs from a micron to
        /// ten kilometres, offset by about a nanometre — no proper crossing
        /// missed, no contact invented.
        #[test]
        fn segment_contact_matches_an_exact_reference(
            exp in -6i32..5,
            far in 0.0f64..4000.0,
            ox in -1.0f64..1.0,
            oy in -1.0f64..1.0,
            ang in 0.0f64..PI,
            tilt in -1e-3f64..1e-3,
            t in -0.2f64..1.2,
            nudge in -3.0f64..3.0,
            shape in 0u8..4,
            turn in 0.01f64..3.1,
            a in 0.0f64..5e-9,
            b in 0.0f64..5e-9,
        ) {
            let scale = 10f64.powi(exp);
            let base = Point3::new(far + ox * scale, far * 0.5 + oy * scale, 0.0);
            let dir = Vec3::new(ang.cos(), ang.sin(), 0.0);
            let nrm = Vec3::new(-dir.y, dir.x, 0.0);
            let p = base;
            let q = base + dir * scale;
            let (r, s) = match shape {
                // Near-parallel, ~nudge nm off.
                0 => {
                    let d2 = (dir + nrm * tilt).normalized().expect("direction");
                    let r = p + nrm * (nudge * 1e-9) + dir * (t * scale);
                    (r, r + d2 * scale)
                }
                // T: an end ~nudge nm off the first segment's body.
                1 => {
                    let foot = p + dir * (t * scale) + nrm * (nudge * 1e-9);
                    (foot, foot + nrm * scale)
                }
                // Crossing within nanometres of the ENDS q and s, at any
                // angle, the segments micrometres to kilometres long.
                3 => {
                    let d2 = Vec3::new((ang + turn).cos(), (ang + turn).sin(), 0.0);
                    let x = q - dir * a;
                    (x - d2 * (scale * (0.3 + t.abs())), x + d2 * b)
                }
                // Acute, crossing within nanometres of an end of each.
                _ => {
                    let d2 = (dir + nrm * (tilt * 50.0 + 1e-4))
                        .normalized()
                        .expect("direction");
                    let x = q - dir * (nudge.abs() * 1e-9);
                    (x - d2 * (scale * 0.5), x + d2 * ((nudge + 3.0) * 1e-9))
                }
            };
            prop_assert_eq!(
                segments_intersect(p, q, r, s),
                reference(p, q, r, s),
                "{:?} {:?} / {:?} {:?}", p, q, r, s
            );
        }
    }
}
