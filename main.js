(function () {
  'use strict';

  /* ============================================================
     PURE MATH / GEOMETRY — angle + path-string helpers, kept free
     of any DOM/SVG calls so they can be unit-tested headlessly.
     ============================================================ */

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function clamp01(v) { return clamp(v, 0, 1); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function deg2rad(d) { return d * Math.PI / 180; }
  function easeOutCubic(x) { return 1 - Math.pow(1 - x, 3); }
  function easeOutBack(x) {
    var c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
  }
  // deliberately NOT clamped to [0,1] -- fed a slightly-overshot progress value
  // (from the explode release-spring) it extrapolates a little past 0/1 too,
  // which is what lets that overshoot actually show up in the 3D transforms
  function easeInOutCubic(x) { return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }
  // "slow -> fast slug -> slow settle" curve used for the intro's zoom-into-
  // center and (via computeCameraMove below) every camera move between circles
  function easeInOutExpo(x) {
    if (x <= 0) return 0; if (x >= 1) return 1;
    return x < 0.5 ? Math.pow(2, 20 * x - 10) / 2 : (2 - Math.pow(2, -20 * x + 10)) / 2;
  }
  // gentle, no-overshoot alternative used for the intro blob's own size growth
  function easeInOutSine(x) { return -(Math.cos(Math.PI * x) - 1) / 2; }
  // "slow start, sharp middle swing, soft landing" -- used for the intro's
  // satellite-orbit rotation (stage 6)
  function easeInOutQuart(x) { return x < 0.5 ? 8 * x * x * x * x : 1 - Math.pow(-2 * x + 2, 4) / 2; }

  // wraps any angle into [0, 360)
  function normalizeDeg(a) { return ((a % 360) + 360) % 360; }

  // shortest signed delta (in (-180, 180]) to rotate `from` into `to`'s
  // equivalence class -- this is what lets continuous dragging/snapping
  // always take the short way around, never the long way
  function shortestDelta(from, to) {
    var d = normalizeDeg(to - from);
    if (d > 180) d -= 360;
    return d;
  }

  // 0deg = straight up (12 o'clock), increasing clockwise -- matches the
  // dial's own stated convention ("1번이 0도=12시, 시계방향")
  function polar(cx, cy, r, angleDeg) {
    var a = deg2rad(angleDeg);
    return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  }

  /* ---------- explode (3-layer exploded-view) interaction math ---------- */

  // movement needed before a pending drag COMMITS to explode/flip -- this
  // must stay comfortably bigger than ordinary click jitter (a real mouse
  // or trackpad click routinely wobbles 5-10px without the user intending
  // any drag at all), or it swallows clicks: a tiny *horizontal* jitter
  // during a click on a dial title, once >= this threshold, unconditionally
  // classifies as 'flip' below (there's no "must move a real distance"
  // guard on that branch the way explode has one for direction) and
  // handleWindowClick never fires, springing silently back to nothing --
  // this was a real, confirmed regression (not a hypothetical) once this
  // was briefly set to 6px to match the click-tolerance figure below,
  // which is a DIFFERENT number measuring a different thing.
  var GESTURE_COMMIT_PX = 14;
  var EXPLODE_DRAG_SPAN_FRAC = 0.45; // progress reaches 1 after dragging up this fraction of screen height
  var EXPLODE_SNAP_THRESHOLD = 0.4; // release above this -> springs open, below -> springs closed
  var EXPLODE_SNAP_DUR = 600;
  var EXPLODE_Z2_FRAC = 0.16, EXPLODE_Z3_FRAC = 0.32; // of the dial's own rendered diameter
  var EXPLODE_ROTATE_X_END = 62, EXPLODE_ROTATE_Z_END = -10;
  var EXPLODE_FIT_WIDTH_FRAC = 0.90; // layer1's tilted ellipse should reach ~90% of viewport width
  var EXPLODE_FIT_HEIGHT_FRAC = 0.88; // ...but the whole scene must not exceed ~88% of viewport height

  // only two gestures exist now (no more drag-to-rotate): a vertical drag is
  // "explode" (3-layer separation), a horizontal drag is "flip" (front/back).
  // Whichever of |dx|/|dy| is bigger wins once the movement clears the
  // GESTURE_COMMIT_PX threshold. `explodeOpen` relaxes explode's "must be
  // moving up" requirement so an already-exploded view can be dragged back
  // down to collapse too. `canExplode`/`canFlip` gate out whichever gesture
  // doesn't make sense in the current state (explode is disabled while
  // flipped to the back, flip is disabled while exploded) -- the two are
  // mutually exclusive "alternate states" of the flat front dial.
  function classifyDragGesture(dx, dy, explodeOpen, canExplode, canFlip) {
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < GESTURE_COMMIT_PX) return null; // not yet decided
    if (Math.abs(dy) >= Math.abs(dx)) {
      if (canExplode && (dy < 0 || explodeOpen)) return 'explode';
      return null; // e.g. dragging down without already being open -- no gesture
    }
    return canFlip ? 'flip' : null;
  }

  // turns a (possibly slightly-overshot, via the release spring) progress
  // value into every derived visual number the explode scene needs, all run
  // through the same easeInOutCubic shaping curve as the spec asks for.
  //
  // the scale we interpolate TOWARD is computed (not hardcoded) from the fully
  // -exploded geometry: layer1's tilted silhouette is an ellipse whose WIDTH
  // stays exactly the original diameter (its left/right points sit ON the
  // rotateX hinge line, so they never move in Z) while its HEIGHT shrinks by
  // cos(rotateX); layer3 additionally floats toward the camera by z3 and, once
  // tilted, that Z offset projects onto screen-Y as z3*sin(rotateX) of extra
  // lift above layer1's own top edge. Fit whichever of (90% of viewport width
  // / that ellipse width) or (88% of viewport height / that total scene
  // height) is smaller, so the exploded view fills the screen without either
  // edge spilling past it.
  function computeExplodeTransforms(progress, diameter, viewportW, viewportH) {
    var e = easeInOutCubic(progress);
    var rotateX = e * EXPLODE_ROTATE_X_END;
    var rotateZ = e * EXPLODE_ROTATE_Z_END;
    var z2 = e * diameter * EXPLODE_Z2_FRAC;
    var z3 = e * diameter * EXPLODE_Z3_FRAC;

    var rotXFullRad = deg2rad(EXPLODE_ROTATE_X_END);
    var ellipseHFull = diameter * Math.cos(rotXFullRad);
    var liftFull = (diameter * EXPLODE_Z3_FRAC) * Math.sin(rotXFullRad);
    var sceneHeightFull = ellipseHFull + liftFull;
    var scaleByWidth = (viewportW * EXPLODE_FIT_WIDTH_FRAC) / diameter;
    var scaleByHeight = (viewportH * EXPLODE_FIT_HEIGHT_FRAC) / sceneHeightFull;
    var targetScale = Math.min(scaleByWidth, scaleByHeight);
    var sceneScale = lerp(1, targetScale, e);

    var lift = z3 * Math.sin(deg2rad(rotateX));
    var translateY = lift / 2; // recenters the scene: layer1 stays put, so the
                                // whole span's midpoint drifted up by lift/2

    return {
      e: e, rotateX: rotateX, rotateZ: rotateZ, sceneScale: sceneScale, targetScale: targetScale,
      z1: 0, z2: z2, z3: z3, translateY: translateY,
      guideOpacity: clamp01(e)
    };
  }

  /* ---------- camera move between two world-space points (center<->satellite,
     satellite<->satellite) -- one continuous curve, not two spliced phases:
     position eases via easeInOutCubic the whole way, while scale follows a
     parabola-shaped dip (zero at both ends, deepest at t=0.5) layered on top
     of a straight interpolation between the start/end scale. For every move
     this file actually uses, start and end scale are the SAME value (every
     idle circle -- center or satellite -- is shown at the identical on-screen
     size), so the dip is the only thing scale does: zoom out, pan, zoom back
     in, as one unified "앞으로 쭉 당겨졌다가 다시 들어가는" curve. ---------- */

  // how far the scale dips at its lowest point (t=0.5), as a fraction of
  // base scale -- computed fresh per-move (see computeCameraDipFactor)
  // rather than a fixed constant, since how far the camera needs to pull
  // back to see both circles depends on how far apart they actually are
  // (which itself depends on the current viewport).
  function computeCameraMove(t, fromPt, toPt, fromScale, toScale, dipFactor) {
    if (dipFactor == null) dipFactor = 0.45;
    t = clamp01(t);
    var posT = easeInOutCubic(t);
    var x = lerp(fromPt.x, toPt.x, posT);
    var y = lerp(fromPt.y, toPt.y, posT);
    var baseScale = lerp(fromScale, toScale, posT);
    var dip = Math.sin(Math.PI * t); // 0 at t=0 and t=1, 1 at t=0.5
    var scale = baseScale * (1 - dip * dipFactor);
    return { x: x, y: y, scale: scale };
  }

  // the scale (relative to the idle on-screen size) the camera needs to
  // dip to so that two D-diameter circles spanWorld world-units apart (the
  // move's start+end points) both stay visible, fit to fitFrac of the
  // viewport's shorter side. Clamped so it never dips LESS than the idle
  // scale (factor<=1) nor collapses to an unusable sliver on tiny viewports.
  function computeCameraDipFactor(viewportW, viewportH, idleScale, spanWorld, fitFrac) {
    fitFrac = fitFrac != null ? fitFrac : 0.85;
    var sDip = (Math.min(viewportW, viewportH) * fitFrac) / spanWorld;
    return clamp(sDip / idleScale, 0.1, 1);
  }

  /* ---------- rounded annular sector path (the project "arc window") ---------- */

  function roundedAnnularSectorPath(cx, cy, ri, ro, a0, a1, corner) {
    var maxCorner = Math.max(1, Math.min(corner, (a1 - a0) / 2 * Math.PI / 180 * ri * 0.9, ro - ri) );
    corner = Math.min(corner, maxCorner <= 0 ? corner : corner); // guard, corner stays as given unless degenerate
    var dOuter = clamp((corner / ro) * 180 / Math.PI, 0, (a1 - a0) / 2 - 0.5);
    var dInner = clamp((corner / ri) * 180 / Math.PI, 0, (a1 - a0) / 2 - 0.5);

    var pOuterStart = polar(cx, cy, ro, a0 + dOuter);
    var pOuterEnd = polar(cx, cy, ro, a1 - dOuter);
    var pInnerStart = polar(cx, cy, ri, a1 - dInner);
    var pInnerEnd = polar(cx, cy, ri, a0 + dInner);

    var pEdge1Outer = polar(cx, cy, ro - corner, a1);
    var pEdge1Inner = polar(cx, cy, ri + corner, a1);
    var pEdge2Outer = polar(cx, cy, ro - corner, a0);
    var pEdge2Inner = polar(cx, cy, ri + corner, a0);

    function P(p) { return p[0].toFixed(2) + ' ' + p[1].toFixed(2); }

    var d = '';
    d += 'M ' + P(pOuterStart);
    d += ' A ' + ro.toFixed(2) + ' ' + ro.toFixed(2) + ' 0 0 1 ' + P(pOuterEnd);
    d += ' A ' + corner.toFixed(2) + ' ' + corner.toFixed(2) + ' 0 0 1 ' + P(pEdge1Outer);
    d += ' L ' + P(pEdge1Inner);
    d += ' A ' + corner.toFixed(2) + ' ' + corner.toFixed(2) + ' 0 0 1 ' + P(pInnerStart);
    d += ' A ' + ri.toFixed(2) + ' ' + ri.toFixed(2) + ' 0 0 0 ' + P(pInnerEnd);
    d += ' A ' + corner.toFixed(2) + ' ' + corner.toFixed(2) + ' 0 0 1 ' + P(pEdge2Inner);
    d += ' L ' + P(pEdge2Outer);
    d += ' A ' + corner.toFixed(2) + ' ' + corner.toFixed(2) + ' 0 0 1 ' + P(pOuterStart);
    d += ' Z';
    return d;
  }

  // a full circle as path data (two half-arcs) -- needed (rather than a plain
  // <circle>) so it can be combined with another circle as a second subpath
  // in one <path d="..."> and fill-rule:evenodd punches a hole with it.
  function fullCirclePath(cx, cy, r) {
    return 'M ' + (cx + r) + ' ' + cy + ' A ' + r + ' ' + r + ' 0 1 0 ' + (cx - r) + ' ' + cy +
      ' A ' + r + ' ' + r + ' 0 1 0 ' + (cx + r) + ' ' + cy + ' Z';
  }
  function donutBackgroundPath(cx, cy, outerR, innerR) {
    return fullCirclePath(cx, cy, outerR) + ' ' + fullCirclePath(cx, cy, innerR);
  }

  // clockwise (increasing-angle) arc from a0 to a1, correct even when that
  // span exceeds 180deg (unlike the simpler window/segment arcs elsewhere in
  // this file, whose spans are always known to stay under 180 so they never
  // needed a real large-arc-flag computation). `reverse` retraces the exact
  // same arc backwards (swapped endpoints + opposite sweep) -- used for the
  // one back-face arc that must read upright despite sitting low enough that
  // the naive direction would otherwise turn it upside-down, same technique
  // as the segment-name flip in buildMidPanel() above.
  function clockwiseArcPath(cx, cy, r, a0, a1, reverse) {
    var span = normalizeDeg(a1 - a0);
    if (span === 0) span = 360;
    var large = span > 180 ? 1 : 0;
    var p0 = polar(cx, cy, r, a0), p1 = polar(cx, cy, r, a1);
    function P(p) { return p[0].toFixed(2) + ' ' + p[1].toFixed(2); }
    if (!reverse) {
      return 'M ' + P(p0) + ' A ' + r.toFixed(2) + ' ' + r.toFixed(2) + ' 0 ' + large + ' 1 ' + P(p1);
    }
    return 'M ' + P(p1) + ' A ' + r.toFixed(2) + ' ' + r.toFixed(2) + ' 0 ' + large + ' 0 ' + P(p0);
  }

  // plain (sharp-cornered) annular sector -- 2 arcs + 2 radial edges, no fillets.
  // used for simple solid bands where rounding was never asked for.
  function annularSectorPath(cx, cy, ri, ro, a0, a1) {
    var pO0 = polar(cx, cy, ro, a0), pO1 = polar(cx, cy, ro, a1);
    var pI0 = polar(cx, cy, ri, a0), pI1 = polar(cx, cy, ri, a1);
    function P(p) { return p[0].toFixed(2) + ' ' + p[1].toFixed(2); }
    var d = '';
    d += 'M ' + P(pO0);
    d += ' A ' + ro.toFixed(2) + ' ' + ro.toFixed(2) + ' 0 0 1 ' + P(pO1);
    d += ' L ' + P(pI1);
    d += ' A ' + ri.toFixed(2) + ' ' + ri.toFixed(2) + ' 0 0 0 ' + P(pI0);
    d += ' Z';
    return d;
  }

  // two segments p1-p2 and p3-p4 -> intersection point, or null if parallel
  function segIntersect(p1, p2, p3, p4) {
    var x1 = p1[0], y1 = p1[1], x2 = p2[0], y2 = p2[1];
    var x3 = p3[0], y3 = p3[1], x4 = p4[0], y4 = p4[1];
    var denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(denom) < 1e-9) return null;
    var t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
    return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
  }

  /* ---------- intro blob/metaball math (pure, no canvas calls -- the
     drawing code in the DOM section below just feeds these numbers to a
     2D context) ---------- */

  // ---- intro reveal v2: blob -> donut -> 6 bumps -> droplet-separation ->
  // damped settle -> center bubble, as ONE continuous metaball field, no
  // renderer swap ever. Modeled on a reference video (화면 기록 2026-11-25
  // 오후 11.02.08.mov), run at ~1.3x its real-world speed. D_UNIT=1000 is
  // the same world-unit "one circle's diameter" every other circle in this
  // file already uses (dialStage, each satellite div), so this and the
  // final 7-circle layout share one consistent scale with no conversion.
  //
  // 18 "ring balls" (6 groups of 3) sit on a circle; 1 "hole" ball
  // subtracts from the field (sign=-1) to cut the donut/star shape; 6
  // small "droplet" balls appear at the snapped necks and get absorbed
  // into a neighbor during settle; 1 "center bubble" ball grows last,
  // filling in where the hole used to be -- 26 seeds total, every one a
  // continuous function of tMs across every stage boundary by
  // construction (verified directly in test_intro_v9.js, not just
  // assumed). ----

  var D_UNIT = 1000;

  // the intro's own settle-stage resting distance for satellites -- also
  // needed by the (unrelated, post-intro) "슉" rotation reveal and the zoom
  // stage, so it lives here in the pure section rather than down in WORLD,
  // where a pure (no-DOM) test harness would never see it assigned at all.
  var SAT_DIST_INTRO = 1.15 * D_UNIT;

  // per-seed low-frequency position jitter -- amplitude supplied by the
  // caller per-stage (0 once stage 6's settle fades it out); period/phase
  // vary by seed index so none of the up-to-26 seeds wobble in lockstep.
  function introNoiseOffset(i, tMs, amp) {
    if (amp <= 0) return [0, 0];
    var tSec = tMs / 1000;
    var period = 0.9 + (i % 11) * 0.065; // spreads ~0.9-1.6s across up to 26 seeds
    var w = 2 * Math.PI / period;
    var phase = i * 1.37;
    return [amp * Math.sin(w * tSec + phase), amp * Math.cos(w * tSec * 0.83 + phase * 1.6)];
  }
  // same idea, but perturbs a seed's own RADIUS instead of its position --
  // what makes the blob/bumps look like they're "꿀렁이며" breathing, not
  // just drifting around.
  function introRadiusNoise(i, tMs, amp) {
    if (amp <= 0) return 0;
    var tSec = tMs / 1000;
    var period = 1.05 + (i % 7) * 0.085;
    var w = 2 * Math.PI / period;
    var phase = i * 2.19 + 10;
    return amp * Math.sin(w * tSec + phase);
  }

  var NI_T1 = 400, NI_T2 = 1200, NI_T3 = 1800, NI_T4 = 2600, NI_T5 = 3300, NI_T6 = 4200;
  var NI_GROUPS = 6, NI_BALLS_PER_GROUP = 3;
  var NI_STAGGER = 50; // ms between each group's own separation-start, within stage 5

  // group g's "home" angle -- g*60-60, not g*60, so that once settled,
  // satellite g's own metaball circle sits EXACTLY where the existing
  // post-intro "슉" rotation (see ROTATION REVEAL in the DOM section --
  // unchanged in spirit, a 60° sweep from i*60-60 to i*60) expects to
  // START its sweep into g's true final angle -- zero jump at that handoff.
  function niGroupAngle(g) { return g * 60 - 60; }

  // fixed/random (picked once, not re-rolled per frame) ±12% size variance
  // per group's bump, per spec -- active during stage 4, faded back to
  // uniform by the end of stage 5 (every group settles to the identical
  // final radius).
  var NI_GROUP_VARIANCE = [];
  for (var niGv = 0; niGv < NI_GROUPS; niGv++) NI_GROUP_VARIANCE.push(1 + (Math.random() * 2 - 1) * 0.12);

  // an exponentially-damped oscillation: 0 at t=0, overshoots/undershoots
  // around 1 for `cycles` periods with decaying amplitude, settling very
  // close to (never touching exactly, by construction) 1 at t=1 -- lerped
  // against a value's own stage-5-end/true-final pair below to get the
  // "2-3번 흔들림" stage 6 bounce. Deliberately left un-clamped past t=1
  // the same way easeOutBack/the explode spring are elsewhere in this
  // file -- the overshoot IS the point.
  function dampedSettle(t, cycles, decay) {
    t = clamp01(t);
    return 1 - Math.exp(-decay * t) * Math.cos(2 * Math.PI * cycles * t);
  }

  // inverse of "N perfectly-overlapping identical seeds, each inflated by
  // META_RADIUS_COMPENSATE" -> the combined rendered contour's radius --
  // lets a per-seed nominal radius be picked from a DESIRED combined/
  // rendered size. Only an EXACT inverse while seeds truly are coincident
  // (stages 1-3, where all 18 ring balls sit at ringDist=0); past that it's
  // still used as a reasoned starting point for a continuous, hand-tuned
  // curve, not re-derived as an exact inverse once the balls actually
  // spread apart (no simple closed form exists for that) -- treat the
  // exact visual proportions from stage 4 onward as an approximation, not
  // a guarantee, same standing caveat as every other hand-tuned visual
  // constant in this file.
  function metaRadiusForCombined(desiredR, n) {
    var factor = Math.sqrt(1 - Math.sqrt(META_THRESHOLD / n));
    return desiredR / factor;
  }

  // per-group radial distance from the origin (the "home" point each
  // group's 3 balls sit around) -- 0 through the blob/donut stages (all 18
  // balls stay bunched at the origin; the donut comes ONLY from the hole
  // seed subtracting from that single bunched mass, no ball motion needed
  // yet), then grows as bumps form and pull apart (staggered 50ms per
  // group within stage 5), then a damped settle onto the final resting
  // distance.
  function niRingDist(tMs, g) {
    if (tMs < NI_T3) return 0;
    if (tMs < NI_T4) return lerp(0, 0.55 * D_UNIT, easeInOutSine(clamp01((tMs - NI_T3) / (NI_T4 - NI_T3))));
    if (tMs < NI_T5) return lerp(0.55 * D_UNIT, 1.1 * D_UNIT, niStage5Progress(tMs, g));
    return lerp(1.1 * D_UNIT, SAT_DIST_INTRO, dampedSettle(clamp01((tMs - NI_T5) / (NI_T6 - NI_T5)), 2.5, 4.5));
  }

  // group g's own staggered stage-5 progress (0..1) -- shared by
  // niRingDist/niUnitSpread/niBallRBase/niDroplet below so all four track
  // EXACTLY the same per-group timing rather than risking subtly different
  // stagger math drifting apart between them.
  function niStage5Progress(tMs, g) {
    if (tMs < NI_T4) return 0;
    if (tMs >= NI_T5) return 1;
    var t5 = tMs - NI_T4, dur5 = NI_T5 - NI_T4;
    var localDur5 = Math.max(1, dur5 - (NI_GROUPS - 1) * NI_STAGGER);
    return easeInOutCubic(clamp01((t5 - g * NI_STAGGER) / localDur5));
  }

  // angular half-spread of a group's 3 balls around niGroupAngle(g) -- 0
  // (coincident) through the blob/donut stages, opens up to make the 6
  // bumps visually distinct in stage 4, then closes back to 0 (the 3 balls
  // converge onto one point) as stage 5 separates them into what will read
  // as a single clean circle each.
  function niUnitSpread(tMs, g) {
    if (tMs < NI_T3) return 0;
    if (tMs < NI_T4) return lerp(0, 16, easeInOutSine(clamp01((tMs - NI_T3) / (NI_T4 - NI_T3))));
    if (tMs < NI_T5) return lerp(16, 0, niStage5Progress(tMs, g));
    return 0;
  }

  // the shared per-ball nominal radius (before each group's own ±12%
  // variance multiplier) -- ONE continuous scalar through every stage; see
  // metaRadiusForCombined's own comment for why only stages 1-3 (all 18
  // balls still exactly coincident there) can treat this as an exact
  // inverse of a desired combined size.
  function niBallRBase(tMs, g) {
    if (tMs < NI_T1) return metaRadiusForCombined(lerp(0, 0.28 * D_UNIT, easeOutCubic(clamp01(tMs / NI_T1))), 18);
    if (tMs < NI_T2) return metaRadiusForCombined(lerp(0.28 * D_UNIT, 1.15 * D_UNIT, easeInOutSine(clamp01((tMs - NI_T1) / (NI_T2 - NI_T1)))), 18);
    var R_T3 = metaRadiusForCombined(1.15 * D_UNIT, 18); // outer edge holds steady through stage 3 -- only the hole grows that stage
    if (tMs < NI_T3) return R_T3;
    if (tMs < NI_T4) return lerp(R_T3, 0.62 * D_UNIT, easeInOutSine(clamp01((tMs - NI_T3) / (NI_T4 - NI_T3))));
    // a deliberate small overshoot past the true final 0.5D (0.54D instead)
    // -- lerping straight to 0.5D would leave stage 6's damped settle
    // below nothing real to visibly oscillate around.
    if (tMs < NI_T5) return lerp(0.62 * D_UNIT, 0.54 * D_UNIT, niStage5Progress(tMs, g));
    return lerp(0.54 * D_UNIT, 0.5 * D_UNIT, dampedSettle(clamp01((tMs - NI_T5) / (NI_T6 - NI_T5)), 2.5, 4.5));
  }

  // position-noise amplitude -- 8% of D through the blob/donut/bump/
  // separation stages per spec, fading to 0 over roughly the first 40% of
  // stage 6 (the damped macro settle above carries the rest of that
  // stage's motion on its own).
  function niNoiseAmp(tMs) {
    if (tMs < NI_T5) return 0.08 * D_UNIT;
    return lerp(0.08 * D_UNIT, 0, clamp01((tMs - NI_T5) / (0.4 * (NI_T6 - NI_T5))));
  }
  function niRadNoiseAmp(tMs) { return niNoiseAmp(tMs) * 0.625; } // 0.05D at full amplitude

  // hole seed radius (subtracted from the field, sign=-1) -- 0 through the
  // blob stage, grows to make the donut in stage 3, holds while the star-
  // shaped bumps form in stage 4 (the star shape is an EMERGENT property
  // of a round hole subtracting from 6 unevenly-clustered bumps, not
  // separately scripted here -- confirmed against a reference-video frame
  // showing exactly this), then shrinks away during separation so nothing
  // is left to subtract from once the center bubble starts growing in the
  // same spot during stage 6.
  function niHoleR(tMs) {
    if (tMs < NI_T2) return 0;
    if (tMs < NI_T3) return lerp(0, 0.45 * D_UNIT, easeInOutSine(clamp01((tMs - NI_T2) / (NI_T3 - NI_T2))));
    if (tMs < NI_T4) return 0.45 * D_UNIT;
    if (tMs < NI_T5) return lerp(0.45 * D_UNIT, 0, easeInOutCubic(clamp01((tMs - NI_T4) / (NI_T5 - NI_T4))));
    return 0;
  }

  // droplet g sits in the gap between group g and group g+1 (angle =
  // niGroupAngle(g)+30) -- appears as that specific neck visually snaps
  // (reusing group g's own staggered niStage5Progress, so the droplet
  // "맺히는" moment lines up with its own neck's snap, not a shared/generic
  // timing), then during stage 6 is pulled into (absorbed by) group g's
  // own final position while shrinking to nothing.
  function niDroplet(tMs, g) {
    var ang = niGroupAngle(g) + 30;
    if (tMs < NI_T5) {
      var pt = polar(0, 0, niRingDist(tMs, g) * 0.7, ang);
      return { x: pt[0], y: pt[1], r: lerp(0, 0.125 * D_UNIT, niStage5Progress(tMs, g)) };
    }
    var pullE = easeInOutCubic(clamp01((tMs - NI_T5) / (NI_T6 - NI_T5))); // accelerating "pulled toward its neighbor"
    var startPt = polar(0, 0, niRingDist(NI_T5, g) * 0.7, ang); // exactly where it was sitting right as stage 5 ended
    var targetPt = polar(0, 0, SAT_DIST_INTRO, niGroupAngle(g)); // absorbed into group g's own final circle
    return {
      x: lerp(startPt[0], targetPt[0], pullE),
      y: lerp(startPt[1], targetPt[1], pullE),
      r: lerp(0.125 * D_UNIT, 0, pullE)
    };
  }

  // the new center circle -- doesn't exist at all until stage 6, then
  // grows (with a slight easeOutBack overshoot, per spec) to fill exactly
  // where the hole used to be.
  function niCenterBubbleR(tMs) {
    if (tMs < NI_T5) return 0;
    return lerp(0, 0.5 * D_UNIT, easeOutBack(clamp01((tMs - NI_T5) / (NI_T6 - NI_T5))));
  }

  // the complete seed list (18 ring balls + 1 hole + 6 droplets + 1 center
  // bubble = 26) at any instant tMs in [0, NI_T6] -- continuous across
  // every stage boundary by construction (every helper above is itself
  // built that way; verified directly, not just assumed, in
  // test_intro_v9.js).
  function computeIntroLayout(tMs) {
    var seeds = [];
    var posAmp = niNoiseAmp(tMs), radAmp = niRadNoiseAmp(tMs);
    for (var g = 0; g < NI_GROUPS; g++) {
      var dist = niRingDist(tMs, g);
      var spread = niUnitSpread(tMs, g);
      var variance = lerp(NI_GROUP_VARIANCE[g], 1, niStage5Progress(tMs, g));
      var baseR = niBallRBase(tMs, g) * variance;
      for (var k = 0; k < NI_BALLS_PER_GROUP; k++) {
        var ballIndex = g * NI_BALLS_PER_GROUP + k;
        var ang = niGroupAngle(g) + (k - 1) * spread;
        var base = polar(0, 0, dist, ang);
        var off = introNoiseOffset(ballIndex, tMs, posAmp);
        var rNoise = introRadiusNoise(ballIndex, tMs, radAmp);
        seeds.push({ x: base[0] + off[0], y: base[1] + off[1], r: Math.max(0, baseR + rNoise), sign: 1 });
      }
    }
    seeds.push({ x: 0, y: 0, r: niHoleR(tMs), sign: -1 });
    for (var g2 = 0; g2 < NI_GROUPS; g2++) {
      var d = niDroplet(tMs, g2);
      seeds.push({ x: d.x, y: d.y, r: d.r, sign: 1 });
    }
    // the center bubble doesn't exist before stage 6 -- no point wobbling
    // a zero-radius seed, and introNoiseOffset(amp<=0) already no-ops, but
    // being explicit here avoids it picking up stage-5 noise amplitude
    // the instant stage 6 begins, before it has any radius to show for it
    var centerNoiseAmp = tMs < NI_T5 ? 0 : niNoiseAmp(tMs);
    var cOff = introNoiseOffset(25, tMs, centerNoiseAmp);
    seeds.push({ x: cOff[0], y: cOff[1], r: niCenterBubbleR(tMs), sign: 1 });
    return { seeds: seeds };
  }

  // with the (1-(d/r)^2)^2 falloff below, a single ISOLATED seed's field
  // only ever reaches exactly 1.0 at its own center (and 0 at d=r) -- there
  // is no plateau at 1.0 anywhere else, so threshold=1.0 degenerates to a
  // single point, not a usable contour. A small positive threshold instead
  // gives each isolated seed a real rendered radius close to (but a bit
  // smaller than) its nominal r; META_RADIUS_COMPENSATE inflates seed radii
  // before field evaluation to compensate, so the RENDERED edge lands back
  // at the seed's intended nominal radius.
  var META_THRESHOLD = 0.015;
  var META_RADIUS_COMPENSATE = 1 / Math.sqrt(1 - Math.sqrt(META_THRESHOLD));

  // classic "soft object" metaball falloff: each seed contributes
  // (1-(d/r)^2)^2 inside its own radius, 0 outside -- sum >= META_THRESHOLD
  // is "inside" the blended shape.
  // `s.sign` (default +1) lets a seed SUBTRACT from the field instead of
  // adding to it -- the intro's single "hole" seed (sign=-1) is what cuts
  // the donut/star shape out of the ring balls' otherwise-solid mass, via
  // the exact same marching-squares pass as everything else (a negative
  // dip below threshold produces its own separate contour loop for free,
  // no special-casing needed anywhere past this function).
  function metaballField(x, y, seeds) {
    var sum = 0;
    for (var i = 0; i < seeds.length; i++) {
      var s = seeds[i];
      var dx = x - s.x, dy = y - s.y;
      var r2 = s.r * s.r;
      var d2 = dx * dx + dy * dy;
      if (d2 < r2) {
        var f = 1 - d2 / r2;
        sum += (s.sign || 1) * f * f;
      }
    }
    return sum;
  }

  // marching squares over a square grid covering [-boundsHalf,boundsHalf]^2,
  // returning the threshold contour as a flat list of [p1,p2] segments
  // (not yet stitched into loops -- see stitchContourLoops below). Saddle
  // cases (5/10) are resolved with a single fixed diagonal choice; a visual
  // seam preference there is a cosmetic, not correctness, concern.
  // `fieldBuffer`, if given (and big enough), is written into directly
  // instead of allocating a fresh array -- the intro reveal calls this
  // every single animation frame, and the field grid (up to ~100x100
  // floats) is by far the biggest per-frame allocation in that loop, so
  // reusing one preallocated buffer there avoids churning the GC every
  // frame. Indexing always uses the CURRENT gridN, so a larger buffer
  // left over from a bigger previous frame is simply partially reused,
  // never read past what this call actually writes.
  function marchMetaballs(seeds, boundsHalf, gridN, fieldBuffer) {
    var n = gridN || 90;
    var cell = (2 * boundsHalf) / n;
    var size = (n + 1) * (n + 1);
    var field = (fieldBuffer && fieldBuffer.length >= size) ? fieldBuffer : new Array(size);
    for (var j = 0; j <= n; j++) {
      for (var i = 0; i <= n; i++) {
        var x = -boundsHalf + i * cell, y = -boundsHalf + j * cell;
        field[j * (n + 1) + i] = metaballField(x, y, seeds);
      }
    }
    function val(i, j) { return field[j * (n + 1) + i]; }
    function pos(i, j) { return [-boundsHalf + i * cell, -boundsHalf + j * cell]; }
    function interp(p1, v1, p2, v2) {
      var t = (META_THRESHOLD - v1) / (v2 - v1);
      t = clamp01(t);
      return [p1[0] + (p2[0] - p1[0]) * t, p1[1] + (p2[1] - p1[1]) * t];
    }
    var segs = [];
    for (var j2 = 0; j2 < n; j2++) {
      for (var i2 = 0; i2 < n; i2++) {
        var v00 = val(i2, j2), v10 = val(i2 + 1, j2), v11 = val(i2 + 1, j2 + 1), v01 = val(i2, j2 + 1);
        var c00 = v00 >= META_THRESHOLD, c10 = v10 >= META_THRESHOLD, c11 = v11 >= META_THRESHOLD, c01 = v01 >= META_THRESHOLD;
        var caseIdx = (c00 ? 1 : 0) | (c10 ? 2 : 0) | (c11 ? 4 : 0) | (c01 ? 8 : 0);
        if (caseIdx === 0 || caseIdx === 15) continue;
        var p00 = pos(i2, j2), p10 = pos(i2 + 1, j2), p11 = pos(i2 + 1, j2 + 1), p01 = pos(i2, j2 + 1);
        var eBottom = interp(p00, v00, p10, v10);
        var eRight = interp(p10, v10, p11, v11);
        var eTop = interp(p01, v01, p11, v11);
        var eLeft = interp(p00, v00, p01, v01);
        switch (caseIdx) {
          case 1: segs.push([eLeft, eBottom]); break;
          case 2: segs.push([eBottom, eRight]); break;
          case 3: segs.push([eLeft, eRight]); break;
          case 4: segs.push([eRight, eTop]); break;
          case 5: segs.push([eLeft, eBottom]); segs.push([eRight, eTop]); break;
          case 6: segs.push([eBottom, eTop]); break;
          case 7: segs.push([eLeft, eTop]); break;
          case 8: segs.push([eTop, eLeft]); break;
          case 9: segs.push([eTop, eBottom]); break;
          case 10: segs.push([eBottom, eRight]); segs.push([eTop, eLeft]); break;
          case 11: segs.push([eTop, eRight]); break;
          case 12: segs.push([eRight, eLeft]); break;
          case 13: segs.push([eRight, eBottom]); break;
          case 14: segs.push([eBottom, eLeft]); break;
        }
      }
    }
    return segs;
  }

  // stitches marchMetaballs' unordered [p1,p2] segments into closed point
  // loops (by chaining matching endpoints within a small tolerance) ready
  // to hand to a canvas fill/smoothing pass.
  function stitchContourLoops(segs) {
    var TOL = 1e-3;
    function closeEnough(a, b) { return Math.abs(a[0] - b[0]) < TOL && Math.abs(a[1] - b[1]) < TOL; }
    var used = [];
    for (var u = 0; u < segs.length; u++) used.push(false);
    var loops = [];
    for (var s = 0; s < segs.length; s++) {
      if (used[s]) continue;
      used[s] = true;
      var loop = [segs[s][0], segs[s][1]];
      var guard = 0;
      while (guard++ < segs.length + 5) {
        var last = loop[loop.length - 1];
        var found = -1, flip = false;
        for (var k = 0; k < segs.length; k++) {
          if (used[k]) continue;
          if (closeEnough(segs[k][0], last)) { found = k; flip = false; break; }
          if (closeEnough(segs[k][1], last)) { found = k; flip = true; break; }
        }
        if (found === -1) break;
        used[found] = true;
        loop.push(flip ? segs[found][0] : segs[found][1]);
        if (closeEnough(loop[loop.length - 1], loop[0])) break;
      }
      if (loop.length >= 3) loops.push(loop);
    }
    return loops;
  }

  // Chaikin corner-cutting: each pair of consecutive points is replaced by
  // two new points at 25%/75% along their segment -- a couple of passes
  // turns the coarse marching-squares polyline into a visually smooth
  // contour with no sharp grid-aligned corners.
  function chaikinSmooth(loop, iterations) {
    iterations = iterations != null ? iterations : 2;
    var pts = loop;
    for (var it = 0; it < iterations; it++) {
      var next = [];
      var n = pts.length;
      for (var i = 0; i < n; i++) {
        var p0 = pts[i], p1 = pts[(i + 1) % n];
        next.push([p0[0] * 0.75 + p1[0] * 0.25, p0[1] * 0.75 + p1[1] * 0.25]);
        next.push([p0[0] * 0.25 + p1[0] * 0.75, p0[1] * 0.25 + p1[1] * 0.75]);
      }
      pts = next;
    }
    return pts;
  }

  /* ---------- version-B sphere: orthographic 3D helpers (pure) ----------
     a single shared "tumble" rotation (yaw around Y, pitch around X, roll
     around Z, composed Rz*Ry*Rx) is applied to every point the sphere scene
     draws -- the wireframe grid, both pairs of orbits, the dashed axes --
     so they all visibly belong to one rigid rotating body. Orthographic
     projection is trivial (just drop z), but z is kept and returned too
     since it's what callers use to dim a label that's rotated onto the
     sphere's far side. */
  function rotate3(p, yaw, pitch, roll) {
    var x = p[0], y = p[1], z = p[2];
    // pitch: rotate around X
    var cp = Math.cos(pitch), sp = Math.sin(pitch);
    var y1 = y * cp - z * sp, z1 = y * sp + z * cp, x1 = x;
    // yaw: rotate around Y
    var cy = Math.cos(yaw), sy = Math.sin(yaw);
    var x2 = x1 * cy + z1 * sy, z2 = -x1 * sy + z1 * cy, y2 = y1;
    // roll: rotate around Z
    var cr = Math.cos(roll), sr = Math.sin(roll);
    var x3 = x2 * cr - y2 * sr, y3 = x2 * sr + y2 * cr, z3 = z2;
    return [x3, y3, z3];
  }

  // a point at `angleDeg` around a circle of the given radius, lying flat in
  // the local XY plane (z=0) before any tilt/tumble is applied -- the common
  // starting point every orbit/wireframe-ring point below is built from
  function circlePoint3(radius, angleDeg) {
    var a = deg2rad(angleDeg);
    return [radius * Math.cos(a), radius * Math.sin(a), 0];
  }

  // radially rescales `p` (toward the origin, same angle) by the SMALLEST
  // amount needed so that `p + offset` (offset a FIXED 2D screen-space
  // vector, e.g. a label box's reach from its anchor dot to its farthest
  // corner) lands within `maxDist` of the origin -- an exact per-position
  // solve (the quadratic in s for |s*p + offset| = maxDist), not a flat
  // worst-case-over-every-angle bound, so a point already safely inside
  // only gets pulled in exactly as far as its OWN current angle actually
  // requires (most positions need no pullback at all), rather than being
  // conservatively parked at one fixed "safe radius" forever regardless of
  // where it currently sits. Used to keep a sphere label's box inside the
  // dial's edge without needlessly shrinking its whole orbit.
  function clampPointToReach(p, offset, maxDist) {
    var cx = p[0] + offset[0], cy = p[1] + offset[1];
    if (cx * cx + cy * cy <= maxDist * maxDist) return p; // already safe
    var a = p[0] * p[0] + p[1] * p[1];
    if (a < 1e-6) return p; // p is basically at the origin -- nothing sensible to scale
    var b = 2 * (p[0] * offset[0] + p[1] * offset[1]);
    var c = offset[0] * offset[0] + offset[1] * offset[1] - maxDist * maxDist;
    var disc = b * b - 4 * a * c;
    if (disc < 0) return p; // shouldn't happen given the check above, but never propagate NaN
    var s = clamp01((-b + Math.sqrt(disc)) / (2 * a));
    return [p[0] * s, p[1] * s, p[2]];
  }

  // expose the pure layer for the headless test harness (no effect in the browser)
  if (typeof module !== 'undefined') {
    module.exports = {
      clamp: clamp, clamp01: clamp01, lerp: lerp, deg2rad: deg2rad,
      easeOutCubic: easeOutCubic, easeOutBack: easeOutBack, easeInOutExpo: easeInOutExpo,
      easeInOutSine: easeInOutSine, easeInOutQuart: easeInOutQuart,
      normalizeDeg: normalizeDeg, shortestDelta: shortestDelta, polar: polar,
      roundedAnnularSectorPath: roundedAnnularSectorPath,
      annularSectorPath: annularSectorPath, segIntersect: segIntersect,
      fullCirclePath: fullCirclePath, donutBackgroundPath: donutBackgroundPath,
      easeInOutCubic: easeInOutCubic, classifyDragGesture: classifyDragGesture,
      computeExplodeTransforms: computeExplodeTransforms, clockwiseArcPath: clockwiseArcPath,
      computeCameraMove: computeCameraMove, computeCameraDipFactor: computeCameraDipFactor,
      introNoiseOffset: introNoiseOffset, introRadiusNoise: introRadiusNoise,
      computeIntroLayout: computeIntroLayout, D_UNIT: D_UNIT, SAT_DIST_INTRO: SAT_DIST_INTRO,
      metaballField: metaballField, marchMetaballs: marchMetaballs, stitchContourLoops: stitchContourLoops,
      chaikinSmooth: chaikinSmooth,
      META_THRESHOLD: META_THRESHOLD, META_RADIUS_COMPENSATE: META_RADIUS_COMPENSATE,
      rotate3: rotate3, circlePoint3: circlePoint3, clampPointToReach: clampPointToReach,
      NI_T1: NI_T1, NI_T2: NI_T2, NI_T3: NI_T3, NI_T4: NI_T4, NI_T5: NI_T5, NI_T6: NI_T6,
      NI_GROUPS: NI_GROUPS, niGroupAngle: niGroupAngle, dampedSettle: dampedSettle,
      metaRadiusForCombined: metaRadiusForCombined, niRingDist: niRingDist,
      niStage5Progress: niStage5Progress, niUnitSpread: niUnitSpread, niBallRBase: niBallRBase,
      niHoleR: niHoleR, niDroplet: niDroplet, niCenterBubbleR: niCenterBubbleR, niNoiseAmp: niNoiseAmp
    };
  }
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  /* ============================================================
     DATA
     ============================================================ */

  // period/category are the satellite circle's own (placeholder) text, per
  // this turn's spec -- year/field are the project-PAGE's own (separately
  // placeholder) meta line, left alone since this turn didn't ask to
  // change the detail page's own content.
  var PROJECTS = [
    { id: 'anox', title: 'ANOX', period: '2025.03 — 2025.06', category: 'Brand Identity', year: '', field: '', cover: '', images: [], desc: [], oneLine: 'A brand identity built from a single object.' },
    { id: 'post-script', title: 'POST SCRIPT', period: '2025.03 — 2025.06', category: 'Brand Identity', year: '', field: '', cover: '', images: [], desc: [], oneLine: 'Typography for the words left after the letter.' },
    { id: 'spora', title: 'SPORA', period: '2025.03 — 2025.06', category: 'Brand Identity', year: '', field: '', cover: '', images: [], desc: [], oneLine: 'A living object that spreads joy like spores.' },
    { id: 'the-receipt-book', title: 'THE RECEIPT BOOK', period: '2025.03 — 2025.06', category: 'Brand Identity', year: '', field: '', cover: '', images: [], desc: [], oneLine: 'Everyday receipts turned into an editorial book.' },
    { id: 'material-study', title: 'MATERIAL STUDY', period: '2025.03 — 2025.06', category: 'Brand Identity', year: '', field: '', cover: '', images: [], desc: [], oneLine: 'Experiments that start from texture, not form.' },
    { id: 'drawing', title: 'DRAWING', period: '2025.03 — 2025.06', category: 'Brand Identity', year: '', field: '', cover: '', images: [], desc: [], oneLine: 'Hand drawings collected between projects.' }
  ];
  var N = PROJECTS.length;
  var PROJECT_STEP = 360 / N; // was hardcoded 72 (for N=5) -- now follows PROJECTS.length directly

  // ---- small center circle content, pulled out as constants so the
  // wording can change without touching the layout code below ----
  var CENTER_TITLE = 'PORTFOLIO';
  var CENTER_SUBTITLE = 'Works from objects to Graphics';
  var CENTER_META = 'Brand designer, 2026, Seoul';
  var CENTER_NAME = 'Kwag so yun';

  // ---- back face (CD-label reference layout) copy -- every string lives
  // here so the layout code below never needs to change just to edit words ----
  var BACK_TEXT = {
    titleLines: [
      'From objects to graphics, I design brands you can hold and remember.',
      'Speculative products, material studies, type and interactive web',
      'Brand Designer, Seoul'
    ],
    numberLabelBefore: 'About Nº',
    number: '01',
    numberLabelAfter: 'Title',
    name: 'Kwag So Yun',
    nameLabel: 'Designer',
    innerArcs: [
      'Selected Works 01—06 · Objects and Graphics',
      'Identity, Product, Material, Print, Drawing',
      'Portfolio 2026'
    ],
    edgeTexts: [
      'New Portfolio',
      'Kwag So Yun Studio',
      'Brand Designer, Seoul',
      'From Objects to Graphics'
    ]
  };

  /* ============================================================
     SVG BUILD
     ============================================================ */

  var SVGNS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs, parent) {
    var el = document.createElementNS(SVGNS, tag);
    if (attrs) for (var k in attrs) el.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(el);
    return el;
  }

  var CX = 500, CY = 500;
  var isMobileBuild = innerWidth < 700;

  // layer 1 (biggest, bottom): bezel + the rotating ringA/ringB
  var bezelFixed = document.getElementById('bezelFixed');
  var rotor = document.getElementById('rotor');
  var layer1Bg = document.getElementById('layer1Bg');
  // layer 2 (middle): ringC's r=320 circle + the scale ring/segment names/title/band
  var layer2Fixed = document.getElementById('layer2Fixed');
  var layer2Bg = document.getElementById('layer2Bg');
  // layer 3 (smallest, top): the bracket ring + all center text + the click zone
  var centerFixed = document.getElementById('centerFixed');
  var layer3Bg = document.getElementById('layer3Bg');
  // back face (CD-label layout), its own separate SVG entirely outside the
  // explode scene -- see buildBackFace() below
  var backFixed = document.getElementById('backFixed');

  var projWindowEls = [], projTitleEls = [], projNumEls = [], projUnderlineEls = [];

  /* ---------- 1. fixed bezel ---------- */

  // bezel's circles pulled in 6px (500/488 -> 494/482) to reclaim the outer
  // margin that's no longer needed now that its numbers moved IN rather than
  // sitting outside the bezel. Tick lengths are untouched, so the major
  // (10-multiple) tick now reaches
  // 458 (482-24) -- still comfortably clear of ring A's own (shrunk, see
  // RING_A_OUTER below) outer edge at 444, a 14-unit gap at every angle.
  // Numbers moved IN from outside the bezel (505) to the middle of that same
  // gap, at 451 -- clear of ring A's edge on one side and the bezel's own
  // major tick on the other, so they don't cross any tick line.
  // (451 = (444 + 458) / 2, hardcoded here since RING_A_OUTER isn't declared
  // until the ring-A section below.)
  var BEZEL_OUTER1 = 494, BEZEL_OUTER2 = 482;
  var BEZEL_TICK_MAJOR = 24, BEZEL_TICK_MED = 14, BEZEL_TICK_MINOR = 8;
  var BEZEL_NUM_R = 451;

  function buildBezel() {
    svgEl('circle', { cx: CX, cy: CY, r: BEZEL_OUTER1, class: 'stroke-main' }, bezelFixed);
    svgEl('circle', { cx: CX, cy: CY, r: BEZEL_OUTER2, class: 'stroke-main' }, bezelFixed);

    var numStep = isMobileBuild ? 20 : 10;
    for (var d = 0; d < 360; d++) {
      var len = (d % 10 === 0) ? BEZEL_TICK_MAJOR : (d % 5 === 0) ? BEZEL_TICK_MED : BEZEL_TICK_MINOR;
      var p0 = polar(CX, CY, BEZEL_OUTER2, d);
      var p1 = polar(CX, CY, BEZEL_OUTER2 - len, d);
      svgEl('line', {
        x1: p0[0].toFixed(2), y1: p0[1].toFixed(2), x2: p1[0].toFixed(2), y2: p1[1].toFixed(2),
        class: 'stroke-sub'
      }, bezelFixed);

      if (d % numStep === 0) {
        var pn = polar(CX, CY, BEZEL_NUM_R, d);
        var t = svgEl('text', {
          x: pn[0].toFixed(2), y: pn[1].toFixed(2), class: 'num-label',
          'text-anchor': 'middle', 'dominant-baseline': 'middle',
          transform: 'rotate(' + d + ' ' + pn[0].toFixed(2) + ' ' + pn[1].toFixed(2) + ')'
        }, bezelFixed);
        t.textContent = String(d);
      }
    }
    // (the 12-o'clock selection-arrow triangle + index line that used to live
    // here were removed -- there is no more "currently selected via rotation"
    // concept now that the rotor never turns; each project window is
    // independently hover/click-able instead, see the interaction code below)
  }

  /* ---------- 2a. ring A: fine slide-rule scale ---------- */

  // whole ring (ticks + numbers) shifted inward by RING_A_SHIFT as one rigid
  // unit -- tick lengths, 0.5deg spacing, and number radius-offset/font-size
  // are untouched, only the base radius moves. RING_A_SHIFT is the MAXIMUM
  // safe shift: ring A's innermost drawn element (its own numbers, which sit
  // closer to center than its tick ends) must stay >=10px outside ring B's
  // own outer reach (RB_OUTER=420) -- that hard clearance rule is what
  // actually pins this number, not the "~8-10%" figure from the request, since
  // honoring a full 8-10% off RING_A_OUTER's prior 462 would have pushed the
  // numbers past that 420+10 floor. 18 is the most it can move while still
  // clearing it with a couple px to spare (was ~4% of 462, smaller than asked
  // for, but a bigger shift just isn't geometrically possible here).
  var RING_A_SHIFT = 18;
  var RING_A_OUTER = 462 - RING_A_SHIFT; // 444
  var RING_A_NUM_R = 450 - RING_A_SHIFT; // 432 (clears RB_OUTER=420 by 12px)

  function buildRingA(g) {
    var numStep = isMobileBuild ? 30 : 15;
    for (var h = 0; h < 720; h++) {
      var d = h * 0.5;
      var isMajor = Math.abs(d % 15) < 1e-6;
      var len = isMajor ? 8 : 4;
      var p0 = polar(CX, CY, RING_A_OUTER, d);
      var p1 = polar(CX, CY, RING_A_OUTER - len, d);
      svgEl('line', {
        x1: p0[0].toFixed(2), y1: p0[1].toFixed(2), x2: p1[0].toFixed(2), y2: p1[1].toFixed(2),
        class: 'stroke-sub'
      }, g);
    }
    for (var d2 = 0; d2 < 360; d2 += numStep) {
      var pn = polar(CX, CY, RING_A_NUM_R, d2);
      var t = svgEl('text', {
        x: pn[0].toFixed(2), y: pn[1].toFixed(2), class: 'num-label-mini',
        'text-anchor': 'middle', 'dominant-baseline': 'middle',
        transform: 'rotate(' + d2 + ' ' + pn[0].toFixed(2) + ' ' + pn[1].toFixed(2) + ')'
      }, g);
      t.textContent = String(d2);
    }
  }

  /* ---------- 2b. ring B: project windows ---------- */

  var RB_OUTER = 420, RB_INNER = 330;
  var RB_WIN_OUTER = 410, RB_WIN_INNER = 335, RB_CORNER = 14;
  // the invisible click/tap/hover zone's own angular half-width -- a flat
  // value now (not derived from a "window width" formula, since there's no
  // visible box left to size it against) per spec's explicit "±25°, 제목이
  // 있는 링 두께"
  var TITLE_HIT_HALFWIDTH = 25;
  var RB_TITLE_ARC_DEG = 52; // fixed title auto-shrink budget (angular), independent of the hit-zone width
  var RB_TITLE_PATH_HALFSPAN = 80; // the textPath itself is built MUCH longer than the readable/hit area so textPath never clips long titles at its own endpoints -- text-anchor:middle + startOffset:50% still centers the glyphs exactly on the vertex angle

  var measureCanvas = document.createElement('canvas');
  var measureCtx = measureCanvas.getContext('2d');
  // base/floor both grown ~1.3x per spec (26->34, 11->14) now that the
  // title is the ONLY visible thing in the window (no more box to share
  // space with)
  function fitTitleFontSize(title, arcLen) {
    var base = 34;
    // must match .proj-title's actual rendered font (var(--sans), now Satoshi)
    // -- measuring against the wrong family would size titles off their real width
    measureCtx.font = '500 ' + base + 'px Satoshi, Pretendard, -apple-system, sans-serif';
    var w = measureCtx.measureText(title).width;
    if (w <= 0) return base;
    var avail = arcLen * 0.88;
    var size = base * Math.min(1, avail / w);
    return clamp(size, 14, base);
  }

  // generalized version of fitTitleFontSize for the back-face arcs: each
  // caller supplies its own base/min/family/style so the one shrink-to-fit
  // routine can serve the italic title lines, the plain name, etc. alike --
  // fitting each line to ITS OWN arc length independently is exactly what
  // makes three lines of very different lengths/radii end up visually
  // near-equal once each has filled its own available space.
  function fitArcFontSize(text, arcLen, opts) {
    opts = opts || {};
    var base = opts.base || 26;
    var min = opts.min != null ? opts.min : 10;
    var weight = opts.weight || 400;
    var style = opts.italic ? 'italic ' : '';
    var family = opts.family || 'Inter, -apple-system, sans-serif';
    measureCtx.font = style + weight + ' ' + base + 'px ' + family;
    var w = measureCtx.measureText(text).width;
    if (w <= 0) return base;
    var avail = arcLen * (opts.fillFrac != null ? opts.fillFrac : 0.92);
    var size = base * Math.min(1, avail / w);
    return clamp(size, min, base);
  }

  function buildRingB(g) {
    var pathDefsParent = svgEl('defs', null, g);

    for (var i = 0; i < N; i++) {
      var vertexAngle = i * PROJECT_STEP;
      var a0 = vertexAngle - TITLE_HIT_HALFWIDTH, a1 = vertexAngle + TITLE_HIT_HALFWIDTH;

      // invisible hit zone -- a flat +/-25deg band now (not derived from the
      // old visible box's width), per spec: "박스가 없으니 각 제목 구간에
      // 투명 클릭 영역을 따로 둘 것"
      var winD = roundedAnnularSectorPath(CX, CY, RB_WIN_INNER, RB_WIN_OUTER, a0, a1, RB_CORNER);
      var win = svgEl('path', { d: winD, class: 'proj-window', 'data-index': i }, g);
      projWindowEls.push(win);

      // vertex reference tick + dot
      var vp0 = polar(CX, CY, RB_OUTER, vertexAngle), vp1 = polar(CX, CY, RB_OUTER - 30, vertexAngle);
      svgEl('line', {
        x1: vp0[0].toFixed(2), y1: vp0[1].toFixed(2), x2: vp1[0].toFixed(2), y2: vp1[1].toFixed(2),
        class: 'stroke-main', 'stroke-width': 2
      }, g);
      var vdot = polar(CX, CY, 325, vertexAngle);
      svgEl('circle', { cx: vdot[0].toFixed(2), cy: vdot[1].toFixed(2), r: 4, class: 'dot' }, g);

      // number, at the window's outer edge
      var np = polar(CX, CY, RB_WIN_OUTER - 10, vertexAngle);
      var numText = svgEl('text', {
        x: np[0].toFixed(2), y: np[1].toFixed(2), class: 'proj-num', 'data-index': i,
        'text-anchor': 'middle', 'dominant-baseline': 'middle',
        transform: 'rotate(' + vertexAngle + ' ' + np[0].toFixed(2) + ' ' + np[1].toFixed(2) + ')'
      }, g);
      numText.textContent = ('0' + (i + 1)).slice(-2);
      projNumEls.push(numText);

      // title along an arc, via textPath. The PATH ITSELF spans a generous
      // +/-80deg around the vertex -- far more than any title actually
      // needs -- specifically so textPath never clips a long title at the
      // path's own endpoints (the real bug behind "MATERIAL STUDY" showing
      // as "ATERIAL STU": the OLD path only spanned the ~32deg hit-zone
      // width, too short for its own text). text-anchor:middle + startOffset
      // 50% still centers the glyphs exactly on vertexAngle regardless of
      // how long the underlying path is.
      var midR = (RB_WIN_INNER + RB_WIN_OUTER) / 2;
      var tp0 = polar(CX, CY, midR, vertexAngle - RB_TITLE_PATH_HALFSPAN), tp1 = polar(CX, CY, midR, vertexAngle + RB_TITLE_PATH_HALFSPAN);
      var pathId = 'projArcPath' + i;
      var arcPath = svgEl('path', {
        id: pathId,
        d: 'M ' + tp0[0].toFixed(2) + ' ' + tp0[1].toFixed(2) + ' A ' + midR.toFixed(2) + ' ' + midR.toFixed(2) + ' 0 0 1 ' + tp1[0].toFixed(2) + ' ' + tp1[1].toFixed(2),
        style: 'fill:none;stroke:none'
      }, pathDefsParent);

      // auto-shrink budget stays a fixed ~52deg (the READABLE width titles
      // are expected to fit within), entirely independent of the much
      // longer path built above -- that path is just room for textPath to
      // lay the glyphs out in without clipping, not the sizing budget itself
      var arcLen = deg2rad(RB_TITLE_ARC_DEG) * midR;
      var fontSize = fitTitleFontSize(PROJECTS[i].title, arcLen);

      var titleText = svgEl('text', { class: 'proj-title', 'data-index': i, 'font-size': fontSize.toFixed(1) }, g);
      var textPathEl = svgEl('textPath', { 'href': '#' + pathId, startOffset: '50%', 'text-anchor': 'middle' }, titleText);
      textPathEl.textContent = PROJECTS[i].title;
      projTitleEls.push(titleText);

      // underline arc -- spans the same ~52deg readable budget (half each
      // side of the vertex), sitting just inside (below) the title's own
      // baseline; this is the hover/selected feedback now that there's no
      // box to invert
      var underlineR = midR - 8;
      var underlineHalf = RB_TITLE_ARC_DEG / 2;
      var up0 = polar(CX, CY, underlineR, vertexAngle - underlineHalf), up1 = polar(CX, CY, underlineR, vertexAngle + underlineHalf);
      var underline = svgEl('path', {
        d: 'M ' + up0[0].toFixed(2) + ' ' + up0[1].toFixed(2) + ' A ' + underlineR.toFixed(2) + ' ' + underlineR.toFixed(2) + ' 0 0 1 ' + up1[0].toFixed(2) + ' ' + up1[1].toFixed(2),
        class: 'proj-underline', 'data-index': i
      }, g);
      projUnderlineEls.push(underline);
      // (the 2deg gap ticks that used to fill the empty space between windows
      // here were removed per spec -- window/vertex-tick/dot/number stay)
    }
  }

  /* ---------- 2c. ring C: orbit / grid graphics ---------- */

  function buildRingC(g) {
    // only the outermost ring (just inside the project arc windows) survives --
    // everything that used to fill the inside of it (inner circles, orbit
    // ellipses, dashed spokes, pentagon/star, intersection dots, arrowheads)
    // was removed per spec, leaving the dial's center empty but for the label
    svgEl('circle', { cx: CX, cy: CY, r: 320, class: 'stroke-sub' }, g);
  }

  /* ---------- 2d. fixed inner panel: circular-slide-rule reference's
     innermost disc, copied in as a non-rotating layer so its text always
     reads upright no matter how far the rotor has turned ---------- */

  var IP_R = 300; // panel radius (320 outer circle minus a 20 margin)
  var IP_TICK_LONG = 12;
  // the small center circle's own radius -- grown from the old bracket
  // ring's 220 up to the scale ring's own inward tick reach (IP_R -
  // IP_TICK_LONG = 288) minus another 12px of clearance = 276 (~25% bigger
  // than 220, and matches "눈금 링 안쪽 끝에서 약 12px 안쪽" exactly)
  var INNER_CIRCLE_R = IP_R - IP_TICK_LONG - 12;

  // ---- layer 2 content: the scale ring itself (baseline + ticks), plus
  // the black band. Segment names/ring title/bracket arrows were all
  // removed per spec -- this ring is now just ticks + the band.
  function buildMidPanel() {
    var g = svgEl('g', { id: 'innerPanel' }, layer2Fixed);

    svgEl('circle', { cx: CX, cy: CY, r: IP_R, class: 'stroke-sub' }, g);

    // scale ticks: every 2deg short(6), every 10deg long(12), pointing inward
    for (var d = 0; d < 360; d += 2) {
      var len = (d % 10 === 0) ? IP_TICK_LONG : 6;
      var p0 = polar(CX, CY, IP_R, d), p1 = polar(CX, CY, IP_R - len, d);
      svgEl('line', {
        x1: p0[0].toFixed(2), y1: p0[1].toFixed(2), x2: p1[0].toFixed(2), y2: p1[1].toFixed(2),
        class: 'stroke-sub'
      }, g);
    }

    // (the solid black band that used to sit near the bottom here was
    // removed per spec -- ticks are now the only thing on this ring)
  }

  /* ---------- 3. fixed center (layer 3): bracket ring + arrows, then all the
     center text, then (via buildCenter() right after) the click zone + label ---------- */

  // natural (unscaled) layout constants for the center content block, per
  // the new spec -- title pinned 0.12*INNER_CIRCLE_R above center, every
  // other row flowing downward from it via explicit gaps.
  var CENTER_TITLE_SIZE0 = isMobileBuild ? 52 : 66; // old PORTFOLIO (46*1.2=55.2) * ~1.2
  var CENTER_SUBTITLE_SIZE0 = isMobileBuild ? 20 : 26;
  var CENTER_META_SIZE0 = isMobileBuild ? 16 : 20;
  var CENTER_NAME_SIZE0 = isMobileBuild ? 13 : 16;
  var CENTER_TITLE_OFFSET0 = 0.16 * INNER_CIRCLE_R; // above center -- nudged up a little from 0.12 per feedback
  var CENTER_SUBTITLE_GAP0 = 20, CENTER_GROUP_GAP0 = 70, CENTER_NAME_GAP0 = 6;

  // lays out all 5 rows at a given uniform scale -- called once at scale=1
  // to measure the natural extent, then again at the derived textScale to
  // get the actual final positions (same "measure unscaled, shrink if it
  // would overflow the circle, redo scaled" pattern this file has always
  // used for this text block).
  function layoutCenterContent(scale) {
    var titleSize = CENTER_TITLE_SIZE0 * scale;
    var subtitleSize = CENTER_SUBTITLE_SIZE0 * scale;
    var metaSize = CENTER_META_SIZE0 * scale;
    var nameSize = CENTER_NAME_SIZE0 * scale;
    var titleY = CY - CENTER_TITLE_OFFSET0 * scale;
    var subtitleY = titleY + titleSize * 0.55 + CENTER_SUBTITLE_GAP0 * scale + subtitleSize * 0.5;
    var metaY = subtitleY + subtitleSize * 0.5 + CENTER_GROUP_GAP0 * scale + metaSize * 0.5;
    var nameY = metaY + metaSize * 0.5 + CENTER_NAME_GAP0 * scale + nameSize * 0.5;
    return {
      titleY: titleY, titleSize: titleSize,
      subtitleY: subtitleY, subtitleSize: subtitleSize,
      metaY: metaY, metaSize: metaSize,
      nameY: nameY, nameSize: nameSize
    };
  }

  // the exact title/subtitle position+size version B's own fixed text reuses
  // below (see CENTER VERSION B) -- stored here, once, rather than
  // recomputed from scratch a second time, so the two versions can never
  // silently drift apart from each other.
  var centerContentLayout = null;

  function buildCenterContent() {
    var g = svgEl('g', { id: 'centerContent' }, centerFixed);

    var natural = layoutCenterContent(1);
    var topExtent = Math.abs(natural.titleY - CY) + natural.titleSize * 0.5;
    var bottomExtent = Math.abs(natural.nameY - CY) + natural.nameSize * 0.5;
    var neededExtent = Math.max(topExtent, bottomExtent);
    var textScale = neededExtent > INNER_CIRCLE_R ? INNER_CIRCLE_R / neededExtent : 1;
    var L = layoutCenterContent(textScale);
    centerContentLayout = L;

    var rows = [
      { y: L.titleY, size: L.titleSize, cls: 'inner-title', text: CENTER_TITLE },
      { y: L.subtitleY, size: L.subtitleSize, cls: 'inner-subtitle', text: CENTER_SUBTITLE },
      { y: L.metaY, size: L.metaSize, cls: 'inner-meta', text: CENTER_META },
      { y: L.nameY, size: L.nameSize, cls: 'inner-name', text: CENTER_NAME }
    ];
    rows.forEach(function (row) {
      var t = svgEl('text', {
        x: CX, y: row.y.toFixed(1), class: row.cls,
        'font-size': row.size.toFixed(2), 'text-anchor': 'middle', 'dominant-baseline': 'middle'
      }, g);
      t.textContent = row.text;
    });
  }

  var CENTER_HIT_R = 60; // invisible click/tap zone, unchanged -- no center click action is currently wired up, but the zone itself is left in place

  function buildCenter() {
    svgEl('circle', { cx: CX, cy: CY, r: CENTER_HIT_R, id: 'centerHit', fill: 'transparent' }, centerFixed);
  }

  /* ---------- back face: CD-label reference layout, concentric arcs only
     (no Archimedean spiral) -- its own flat disc, entirely separate from the
     3 explode layers, so it needs no donut-punch background of its own ---------- */

  var BACK_R = BEZEL_OUTER1; // same visual radius as the front dial's own outer edge
  var BACK_GREY_OUTER_R = 0.36 * BACK_R;
  var BACK_GREY_INNER_R = 0.15 * BACK_R;

  // builds one invisible arc path (clockwise a0->a1, or its reverse) plus the
  // <text>/<textPath> that rides it -- the one shared primitive every back-
  // face arc item below is built from.
  function buildBackArcText(parent, defsParent, idBase, r, a0, a1, reverse, className, content, fontSizeOverride) {
    var d = clockwiseArcPath(CX, CY, r, a0, a1, reverse);
    svgEl('path', { id: idBase, d: d, style: 'fill:none;stroke:none' }, defsParent);
    var t = svgEl('text', { class: className }, parent);
    if (fontSizeOverride != null) t.setAttribute('font-size', fontSizeOverride.toFixed(2));
    var tp = svgEl('textPath', { href: '#' + idBase, startOffset: '50%', 'text-anchor': 'middle' }, t);
    tp.textContent = content;
    return t;
  }

  function buildBackFace() {
    var g = backFixed;
    var defs = svgEl('defs', null, g);

    svgEl('circle', { cx: CX, cy: CY, r: BACK_R, style: 'fill:var(--back-paper);stroke:none' }, g);
    svgEl('path', {
      d: donutBackgroundPath(CX, CY, BACK_GREY_OUTER_R, BACK_GREY_INNER_R),
      'fill-rule': 'evenodd', style: 'fill:var(--back-grey);stroke:none'
    }, g);
    svgEl('circle', { cx: CX, cy: CY, r: BACK_R, class: 'stroke-main' }, g);

    // 1. main title, 3 lines, outer -> inner. Naive (uncorrected) arc
    // direction everywhere here -- a CD label's radial text is conventionally
    // "upright" relative to OUTWARD, not relative to the viewer, so letting
    // glyph-up point away from center all the way around is the correct,
    // intentional look, not a bug (unlike the dial-front segment names, which
    // DO want viewer-upright reading since those sit flat and still).
    var titleSpecs = [
      { r: 0.86 * BACK_R, a0: 300, a1: 170 },
      { r: 0.77 * BACK_R, a0: 300, a1: 95 },
      { r: 0.68 * BACK_R, a0: 305, a1: 20 }
    ];
    titleSpecs.forEach(function (spec, i) {
      var span = normalizeDeg(spec.a1 - spec.a0); if (span === 0) span = 360;
      var arcLen = deg2rad(span) * spec.r;
      var text = BACK_TEXT.titleLines[i];
      var fs = fitArcFontSize(text, arcLen, { base: 28, min: 15, italic: true, fillFrac: 0.94 });
      buildBackArcText(g, defs, 'backTitleArc' + i, spec.r, spec.a0, spec.a1, false, 'back-title', text, fs);
    });

    // 2. number block near 293deg/0.80R -- label/number/label as 3 short
    // point-texts a few degrees apart along the same radius, each
    // individually radial-rotated (same rotate(d,x,y) technique as the
    // bezel/ring-A numbers) so the stack reads as one unit tilted to follow
    // the arc, without needing a true curved textPath for such short labels.
    var numBaseAngle = 293, numR = 0.80 * BACK_R;
    [
      { d: numBaseAngle - 7, text: BACK_TEXT.numberLabelBefore, cls: 'back-num-label' },
      { d: numBaseAngle, text: BACK_TEXT.number, cls: 'back-num' },
      { d: numBaseAngle + 9, text: BACK_TEXT.numberLabelAfter, cls: 'back-num-label' }
    ].forEach(function (item) {
      var p = polar(CX, CY, numR, item.d);
      var t = svgEl('text', {
        x: p[0].toFixed(2), y: p[1].toFixed(2), class: item.cls,
        'text-anchor': 'middle', 'dominant-baseline': 'middle',
        transform: 'rotate(' + item.d + ' ' + p[0].toFixed(2) + ' ' + p[1].toFixed(2) + ')'
      }, g);
      t.textContent = item.text;
    });

    // 3. name ("upper-right down to lower-right") + its small label just
    // before it -- naive direction, which is already consistent with that
    // description (not past the point of looking upside-down yet)
    var nameR = 0.60 * BACK_R, nameA0 = 30, nameA1 = 140;
    buildBackArcText(g, defs, 'backNameLabelArc', nameR, nameA0 - 16, nameA0 - 4, false, 'back-num-label', BACK_TEXT.nameLabel);
    buildBackArcText(g, defs, 'backNameArc', nameR, nameA0, nameA1, false, 'back-name', BACK_TEXT.name);

    // 4. small inner-arc texts
    var ia0R = 0.50 * BACK_R;
    buildBackArcText(g, defs, 'backInnerArc0', ia0R, 290, 350, false, 'back-inner-arc', BACK_TEXT.innerArcs[0]);

    var ia1R = 0.46 * BACK_R;
    // explicitly must read normally/outward despite sitting low enough (down
    // to a1=150) that the naive direction would otherwise turn it upside-down
    buildBackArcText(g, defs, 'backInnerArc1', ia1R, 60, 150, true, 'back-inner-arc', BACK_TEXT.innerArcs[1]);
    // deliberately left upside-down/reversed (naive, uncorrected) -- the one
    // spot the spec calls for the "wrong" reading on purpose
    buildBackArcText(g, defs, 'backInnerArc2', ia1R, 170, 230, false, 'back-inner-arc', BACK_TEXT.innerArcs[2]);

    // 5. 4 small edge texts, just inside the border -- plain point-texts
    // rotated radially (same rotate(d,x,y) technique as the bezel/ring-A
    // numbers), which alone produces the described horizontal / vertical-
    // reading-up / vertical-reading-down / flipped variety with no per-item
    // special-casing at all
    var edgeR = 0.94 * BACK_R;
    var edgeAngles = [30, 285, 105, 215];
    edgeAngles.forEach(function (d, i) {
      var p = polar(CX, CY, edgeR, d);
      var t = svgEl('text', {
        x: p[0].toFixed(2), y: p[1].toFixed(2), class: 'back-edge',
        'text-anchor': 'middle', 'dominant-baseline': 'middle',
        transform: 'rotate(' + d + ' ' + p[0].toFixed(2) + ' ' + p[1].toFixed(2) + ')'
      }, g);
      t.textContent = BACK_TEXT.edgeTexts[i];
    });
  }

  /* ---------- per-layer opaque background (paper-colored), one flat sheet
     with no thickness: just a fill plus a single border line wherever that
     edge isn't ALREADY drawn by some other graphic on the very same layer
     (layer1's outer=bezel's own circles, layer2's outer=ringC's own circle,
     layer3's outer=the bracket ring itself -- so only each donut layer's
     INNER hole edge actually needs a new stroke here, to avoid doubling up
     any line that already exists) ---------- */

  function buildLayerBg(container, outerR, innerR) {
    if (innerR != null) {
      svgEl('path', { d: donutBackgroundPath(CX, CY, outerR, innerR), 'fill-rule': 'evenodd', fill: '#FFFFFF', stroke: 'none' }, container);
      svgEl('circle', { cx: CX, cy: CY, r: innerR, class: 'stroke-main' }, container);
    } else {
      svgEl('circle', { cx: CX, cy: CY, r: outerR, fill: '#FFFFFF', stroke: 'none' }, container);
    }
  }

  function build() {
    // layer 1 (bezel + rotor): unchanged content, just now in its own SVG
    buildLayerBg(layer1Bg, 490, 320);
    buildBezel();
    var ringA = svgEl('g', { id: 'ringA' }, rotor);
    var ringB = svgEl('g', { id: 'ringB' }, rotor);
    buildRingB(ringB);
    buildRingA(ringA);

    // layer 2: the r=320 circle (rotationally symmetric, so it doesn't need to
    // actually sit in the rotating group to look right) + the scale ring
    buildLayerBg(layer2Bg, 320, INNER_CIRCLE_R);
    buildRingC(layer2Fixed);
    buildMidPanel();

    // layer 3: small center circle's content, click zone
    buildLayerBg(layer3Bg, INNER_CIRCLE_R, null);
    buildCenterContent();
    buildCenter();

    buildBackFace();
  }
  build();

  /* ============================================================
     WORLD: the center dial + 6 surrounding "satellite" circles, one per
     project, all living in a single shared coordinate plane (world-space
     units == the same 1000-unit scale as the dial's own SVG viewBox). The
     camera (see CAMERA below) is the only thing that ever moves -- every
     circle's own position/size in world-space is fixed forever, set once
     here at build time.
     ============================================================ */

  var worldEl = document.getElementById('world');
  var satellitesContainer = document.getElementById('satellites');

  // SAT_DIST_FINAL is the idle/main resting distance (also what every
  // project-select camera move is computed against); SAT_DIST_INTRO (now
  // declared up in the pure-math section, since the new intro's own settle
  // stage needs it too) is the separate, SMALLER distance satellites orbit
  // at during the intro's reveal, before the zoom spreads them out the
  // rest of the way to SAT_DIST_FINAL in lockstep with the final zoom-in.
  var SAT_DIST_FINAL = 1000 * 2.0;
  var SAT_POS = []; // world-space {x,y} of each satellite at rest (SAT_DIST_FINAL), index-aligned with PROJECTS
  var satEls = [];

  // satContentEls[i] is the TEXT wrapper only -- .sat-circle itself (the
  // border+background "face") is never touched by the intro's content-
  // fade anymore, see the ROTATION REVEAL section below for why that split
  // matters (keeps the face a constant #F2F1EC throughout, instead of the
  // whole circle -- face included -- fading in via one shared opacity).
  var satContentEls = [];

  function buildSatellites() {
    for (var i = 0; i < N; i++) {
      var p = polar(0, 0, SAT_DIST_FINAL, i * PROJECT_STEP);
      SAT_POS.push({ x: p[0], y: p[1] });

      var div = document.createElement('div');
      div.className = 'satellite';
      div.setAttribute('data-index', i);
      div.style.left = (p[0] - 500) + 'px';
      div.style.top = (p[1] - 500) + 'px';

      var circle = document.createElement('div');
      circle.className = 'sat-circle';

      var content = document.createElement('div');
      content.className = 'sat-content';

      // top -> bottom, per spec: number, title (dial font, centered),
      // period + category (placeholder), "VIEW PROJECT ->"
      var num = document.createElement('div');
      num.className = 'sat-num';
      num.textContent = ('0' + (i + 1)).slice(-2);

      var name = document.createElement('div');
      name.className = 'sat-name';
      name.textContent = PROJECTS[i].title;

      var period = document.createElement('div');
      period.className = 'sat-period';
      period.textContent = PROJECTS[i].period;

      var category = document.createElement('div');
      category.className = 'sat-category';
      category.textContent = PROJECTS[i].category;

      var view = document.createElement('div');
      view.className = 'sat-view';
      view.textContent = 'VIEW PROJECT →';

      content.appendChild(num); content.appendChild(name);
      content.appendChild(period); content.appendChild(category); content.appendChild(view);
      circle.appendChild(content);
      div.appendChild(circle);
      satellitesContainer.appendChild(div);
      satEls.push(div);
      satContentEls.push(content);
    }
  }
  buildSatellites();

  // moves a satellite's REAL div to an arbitrary (dist,angle) -- used only
  // during the intro's own orbit/separation/spread stages (6 and 7); at
  // every other time satellite position is fixed forever at SAT_POS[i]
  // (set once above) and only the camera itself ever moves, per this file's
  // established world/camera architecture.
  function setSatellitePosition(i, dist, angleDeg) {
    var p = polar(0, 0, dist, angleDeg);
    satEls[i].style.left = (p[0] - 500) + 'px';
    satEls[i].style.top = (p[1] - 500) + 'px';
  }

  /* ============================================================
     THEME: removed entirely per spec -- the page background is now a
     permanent #0B0B0B (--page-bg) that never brightens, and the dial/
     satellite faces are a permanent off-white/#111 (--ink/--paper), so
     there is nothing left to crossfade. (Previously this section animated
     --ink/--paper from dark to light as the intro zoomed in.)
     ============================================================ */

  /* ============================================================
     INTERACTION STATE
     ============================================================ */

  var dialStage = document.getElementById('dialStage');
  var flipStage = document.getElementById('flipStage');
  var backFace = document.getElementById('backFace');
  var explodeScene = document.getElementById('explodeScene');
  var layerGroup1 = document.getElementById('layerGroup1');
  var layerGroup2 = document.getElementById('layerGroup2');
  var layerGroup3 = document.getElementById('layerGroup3');
  var guideLinesContainer = document.getElementById('guideLines');
  var cameraViewport = document.getElementById('cameraViewport');
  var angleReadout = document.getElementById('angleReadout'); // repurposed: static "SELECT A WORK" label
  var selectReadout = document.getElementById('selectReadout'); // repurposed: hovered project readout

  /* ---------- camera: a single translate+scale on #world, computed fresh
     every frame from whichever world-space point it's currently centered
     on (dial center, a satellite, or a live move between two points) ---------- */

  function idleDialPx() { return Math.min(0.88 * innerWidth, 0.86 * innerHeight); }

  var globalPhase = 'intro'; // 'intro' | 'idle-center' | 'moving-to-sat' | 'idle-sat' | 'moving-to-center' | 'moving-to-neighbor'
  var camTargetX = 0, camTargetY = 0; // world point the camera rests on once idle

  var cameraMode = 'idle'; // 'idle' | 'moving'
  var cameraMoveStart = 0, cameraMoveDur = 0;
  var cameraFromPt = { x: 0, y: 0 }, cameraToPt = { x: 0, y: 0 }, cameraMoveScale = 1, cameraMoveDip = 0.45;
  var cameraOnDone = null;
  var CAMERA_MOVE_DUR = 1200;
  var CAMERA_FIT_FRAC = 0.85; // how much of the viewport's shorter side the two circles' combined span should fill at the dip's lowest point

  function startCameraMove(fromPt, toPt, dur, onDone) {
    cameraMode = 'moving';
    cameraMoveStart = performance.now();
    cameraMoveDur = dur;
    cameraFromPt = fromPt; cameraToPt = toPt;
    cameraMoveScale = idleDialPx() / 1000; // same idle size at both ends, per spec
    // every move this file triggers (center<->satellite, satellite<->
    // satellite) travels exactly SAT_DIST_FINAL (a regular hexagon's side
    // length equals its circumradius, so adjacent satellites are also
    // SAT_DIST_FINAL apart) -- combined bounding span of both D-diameter
    // circles is travel-distance + D, recomputed live against the CURRENT
    // viewport/distance rather than a fixed constant, per this turn's
    // explicit "거리에 맞게 조정" instruction.
    cameraMoveDip = computeCameraDipFactor(innerWidth, innerHeight, cameraMoveScale, SAT_DIST_FINAL + 1000, CAMERA_FIT_FRAC);
    cameraOnDone = onDone || null;
  }

  /* ---------- intro: blob -> donut -> 6 bumps -> droplet-separation ->
     damped settle -> center bubble (see computeIntroLayout above), then the
     "슉" rotation reveal, then one continuous zoom into the center circle.
     Shortened on repeat visits in the same session (sessionStorage,
     try/catch'd since it can throw in some embedded/private contexts) --
     NOT by compressing every stage proportionally, but by skipping
     straight to the rotation reveal (NI_T6). INTRO_REVEAL_DUR itself is
     declared down by the rotation-reveal code, right after
     INTRO_ROTATE_DUR, so the two stay visibly next to each other. ---------- */

  var INTRO_ZOOM_DUR = 1600; // the zoom stage, after the reveal

  var INTRO_SEEN_KEY = 'npIntroSeen';
  var introSeenBefore = false;
  try { introSeenBefore = sessionStorage.getItem(INTRO_SEEN_KEY) === '1'; } catch (e) { /* ignore */ }

  var introStart = 0;
  var introDone = false;

  function introRevealScale() {
    // d (one circle's diameter) = D_UNIT world units; per spec this reads
    // as ~8.5% of the screen's shorter side -- this is also exactly the
    // camera's scale throughout the whole blob+rotation reveal (both read
    // this same function's return value, not a separate constant), and the
    // starting point the zoom stage eases away from afterward.
    return (0.085 * Math.min(innerWidth, innerHeight)) / D_UNIT;
  }

  function markMetaVisible() {
    var metas = document.querySelectorAll('.meta');
    for (var i = 0; i < metas.length; i++) metas[i].classList.add('visible');
  }

  /* ---------- intro canvas: ONE metaball system, start to finish (see
     computeIntroLayout above) -- no blob renderer, no shape crossfade.
     Lives inside #world (world-space units, like dialStage/satellites), so
     the ambient camera transform scales/positions it automatically -- no
     separate screen-space math needed here at all. ---------- */

  var introCanvas = document.getElementById('introCanvas');
  var introCtx = introCanvas.getContext('2d');
  var CANVAS_SIZE = 3400; // world units, centered on world origin -- comfortably covers the full flower
  var INTRO_FILL_COLOR = '#F2F1EC'; // == --paper (the permanent dial/satellite face color), written literally since canvas can't read a CSS var
  var introCanvasHidden = false;

  // reused every frame instead of allocating a fresh field array each time
  // (the field grid is by far the biggest per-frame allocation in this
  // loop) -- sized for the worst case (full spread, ~1.58*D_UNIT reach,
  // cell=0.04*D_UNIT -> ~80 cells across); marchMetaballs only ever reads/
  // writes the first (gridN+1)^2 entries of whatever buffer it's given, so
  // a buffer sized for the largest frame is always safe for smaller ones too.
  var INTRO_MAX_GRID_N = 100;
  var introFieldBuffer = new Array((INTRO_MAX_GRID_N + 1) * (INTRO_MAX_GRID_N + 1));

  function setupIntroCanvas() {
    var dpr = (typeof devicePixelRatio !== 'undefined' && devicePixelRatio) ? devicePixelRatio : 1;
    introCanvas.width = CANVAS_SIZE * dpr;
    introCanvas.height = CANVAS_SIZE * dpr;
    introCanvas.style.width = CANVAS_SIZE + 'px';
    introCanvas.style.height = CANVAS_SIZE + 'px';
    introCanvas.style.left = (-CANVAS_SIZE / 2) + 'px';
    introCanvas.style.top = (-CANVAS_SIZE / 2) + 'px';
    introCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function toCanvasXY(wx, wy) { return [wx + CANVAS_SIZE / 2, wy + CANVAS_SIZE / 2]; }

  // Chaikin-smoothed, straight-line-through-dense-points fill -- a couple
  // of corner-cutting passes turn the coarse marching-squares polyline
  // into a visually smooth contour with no sharp grid-aligned corners.
  // fills ALL of a frame's contour loops in ONE path with fill-rule
  // evenodd -- required now that a frame can have more than one loop
  // nested inside another (the donut/star stages: an outer ring boundary
  // AND a separate inner hole-boundary loop, both produced by the SAME
  // marching-squares pass thanks to the hole seed's sign=-1). Filling each
  // loop independently (the old per-loop approach) would just paint the
  // hole's interior the same color a second time on top of the
  // already-filled outer region -- no visible hole at all. evenodd doesn't
  // care which way each loop winds (unlike nonzero), so it's robust
  // regardless of marching-squares' own winding convention for inner vs.
  // outer contours.
  function fillLoopsEvenOdd(loops, alpha) {
    if (!loops.length) return;
    introCtx.beginPath();
    loops.forEach(function (loop) {
      var pts = chaikinSmooth(loop, 2).map(function (p) { return toCanvasXY(p[0], p[1]); });
      introCtx.moveTo(pts[0][0], pts[0][1]);
      for (var i = 1; i < pts.length; i++) introCtx.lineTo(pts[i][0], pts[i][1]);
      introCtx.closePath();
    });
    introCtx.globalAlpha = alpha;
    introCtx.fillStyle = INTRO_FILL_COLOR;
    introCtx.fill('evenodd');
    introCtx.globalAlpha = 1;
  }

  // the grid's world-space extent and resolution both track the CURRENT
  // blob size every frame (bounds = tight fit around the actual seeds right
  // now, cell size pinned to ~4% of D_UNIT per spec) -- this is what keeps
  // the contour from ever looking blocky while small AND keeps the grid
  // from being needlessly huge while the blob is still tiny early on.
  function metaLoopsForIntro(seeds) {
    var maxReach = 0;
    for (var i = 0; i < seeds.length; i++) {
      var reach = Math.sqrt(seeds[i].x * seeds[i].x + seeds[i].y * seeds[i].y) + seeds[i].r;
      if (reach > maxReach) maxReach = reach;
    }
    var boundsHalf = maxReach + 0.1 * D_UNIT;
    var cell = 0.04 * D_UNIT;
    var gridN = Math.min(INTRO_MAX_GRID_N, Math.max(8, Math.ceil((2 * boundsHalf) / cell)));
    var compSeeds = seeds.map(function (s) { return { x: s.x, y: s.y, r: s.r * META_RADIUS_COMPENSATE, sign: s.sign }; });
    var segs = marchMetaballs(compSeeds, boundsHalf, gridN, introFieldBuffer);
    return stitchContourLoops(segs).filter(function (loop) { return loop.length >= 6; }); // drop degenerate grid-seam specks
  }

  function drawIntroBlob(tMs) {
    var layout = computeIntroLayout(tMs);
    fillLoopsEvenOdd(metaLoopsForIntro(layout.seeds), 1);
  }

  function hideIntroCanvas() {
    if (introCanvasHidden) return;
    introCanvasHidden = true;
    introCanvas.style.display = 'none';
  }

  function updateIntroReveal(tMs) {
    if (introCanvasHidden) return;
    introCtx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    drawIntroBlob(tMs);
  }

  /* ---------- rotation reveal: the post-blob "슉" 60° swish (unchanged in
     spirit/duration/easing from before) + the real dial/satellite content
     fading in -- but now rendered ENTIRELY via the real DOM, not canvas.
     Fixes the "circle dims to gray mid-transition" bug: the old version
     crossfaded a canvas-drawn SOLID disc into a stroke-only OUTLINE while
     the real content (face AND text together, one shared opacity) faded
     in underneath -- two independently-translucent white layers stacked
     over the dark page background don't sum to white, they read as a
     grayish smear for most of the transition. Fixed by never letting the
     face itself be translucent at all: the canvas hands off to the real
     DOM in one instant, pixel-matched (same position/size/color -- the
     face groups, see buildLayerBg/.sat-circle, are hard-coded #F2F1EC and
     were never touched by the old crossfade's alpha either), and ONLY
     THEN does the CONTENT (dial graphics/text, a separate opacity from the
     face) fade in on top of an already-fully-opaque, correctly-colored
     face -- never two superimposed translucent layers at once. ---------- */

  var INTRO_ROTATE_DUR = 700; // unchanged duration from the old stage-6 rotation
  var DIAL_CONTENT_GROUPS = [bezelFixed, rotor, layer2Fixed, centerFixed]; // everything except the always-opaque *Bg face groups
  function setDialContentOpacity(v, withTransition) {
    var tf = withTransition ? ('opacity ' + INTRO_ROTATE_DUR + 'ms ease') : 'none';
    DIAL_CONTENT_GROUPS.forEach(function (el) { el.style.transition = tf; el.style.opacity = String(v); });
  }
  function setSatContentOpacity(v, withTransition) {
    var tf = withTransition ? ('opacity ' + INTRO_ROTATE_DUR + 'ms ease') : 'none';
    satContentEls.forEach(function (el) { el.style.transition = tf; el.style.opacity = String(v); });
  }

  var rotationRevealStarted = false;
  // tMsIntoReveal: elapsed time since NI_T6 (this sub-stage's own t=0), in [0, INTRO_ROTATE_DUR]
  function updateRotationReveal(tMsIntoReveal) {
    if (!rotationRevealStarted) {
      rotationRevealStarted = true;
      hideIntroCanvas(); // the blob/field rendering is done -- everything from here is real DOM
      for (var i = 0; i < 6; i++) setSatellitePosition(i, SAT_DIST_INTRO, i * 60 - 60);
      // faces pop in INSTANTLY, at full opacity, no transition -- this is
      // the actual fix: there is no frame where a face is translucent.
      dialStage.style.transition = 'none'; dialStage.style.opacity = '1';
      satEls.forEach(function (el) { el.style.transition = 'none'; el.style.opacity = '1'; });
      setDialContentOpacity(0, false);
      setSatContentOpacity(0, false);
      // double-rAF: forces the browser to actually paint the "content
      // opacity 0, no transition" state above before the transition below
      // is allowed to kick in -- without this the two opacity writes can
      // coalesce into one paint and the fade never visibly plays at all.
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          setDialContentOpacity(1, true);
          setSatContentOpacity(1, true);
        });
      });
    }
    var e = easeInOutQuart(clamp01(tMsIntoReveal / INTRO_ROTATE_DUR));
    for (var i2 = 0; i2 < 6; i2++) setSatellitePosition(i2, SAT_DIST_INTRO, lerp(i2 * 60 - 60, i2 * 60, e));
  }

  // initial hidden state for the real dial/satellite content -- the
  // rotation reveal above is what brings it back (face instantly, content
  // via its own fade), in lockstep with the canvas disappearing.
  function initIntroHidden() {
    dialStage.style.transition = 'none'; dialStage.style.opacity = '0';
    satEls.forEach(function (el) { el.style.transition = 'none'; el.style.opacity = '0'; });
    setDialContentOpacity(0, false);
    setSatContentOpacity(0, false);
  }

  function finishIntro() {
    introDone = true;
    globalPhase = 'idle-center';
    camTargetX = 0; camTargetY = 0;
    markMetaVisible();
    applyStoredCenterVersionIfNeeded();
    try { sessionStorage.setItem(INTRO_SEEN_KEY, '1'); } catch (e) { /* ignore */ }
  }

  // clicking/tapping during the reveal skips straight to the start of the
  // zoom stage -- the zoom itself still plays out normally, per this
  // file's long-standing "확대만 재생" rule (not an instant finish).
  function skipIntro() {
    if (globalPhase !== 'intro') return;
    var tSince = performance.now() - introStart;
    if (tSince >= INTRO_REVEAL_DUR) return; // already zooming -- nothing left to skip
    hideIntroCanvas();
    for (var i = 0; i < 6; i++) setSatellitePosition(i, SAT_DIST_INTRO, i * PROJECT_STEP);
    dialStage.style.transition = 'none'; dialStage.style.opacity = '1';
    satEls.forEach(function (el) { el.style.transition = 'none'; el.style.opacity = '1'; });
    setDialContentOpacity(1, false);
    setSatContentOpacity(1, false);
    rotationRevealStarted = true;
    introStart = performance.now() - INTRO_REVEAL_DUR;
  }
  cameraViewport.addEventListener('pointerdown', function () {
    if (globalPhase === 'intro') skipIntro();
  });

  // total reveal duration = the blob/field system (0..NI_T6) + the
  // rotation reveal (NI_T6..+INTRO_ROTATE_DUR) -- then the zoom stage below.
  var INTRO_REVEAL_DUR = NI_T6 + INTRO_ROTATE_DUR;

  // single shared camera transform for BOTH the dial and the satellites --
  // `s` here is the ONLY scale either one is ever drawn at (applied to
  // #world as a whole in frame()); satellite DISTANCE-from-origin and this
  // scale are interpolated through the exact same eased progress `e`, so
  // there is no way for "the ring spreads faster/slower than the camera
  // zooms" to happen -- fixes the earlier "둘레 원은 크게, 가운데 다이얼은
  // 작게 따로 노는" bug, which traced back to the two no longer being
  // computed from one shared progress value. dialStage's own SVG content
  // is sized to the dial's final diameter from build() onward and is never
  // resized/rebuilt here or anywhere else -- the zoom only ever changes
  // #world's transform, never dialStage's own content.
  function currentCameraFrame(now) {
    if (globalPhase === 'intro') {
      var tSince = now - introStart;
      if (tSince < NI_T6) {
        updateIntroReveal(tSince);
        return { x: 0, y: 0, s: introRevealScale() };
      }
      if (tSince < INTRO_REVEAL_DUR) {
        updateRotationReveal(tSince - NI_T6);
        return { x: 0, y: 0, s: introRevealScale() };
      }
      if (!rotationRevealStarted) updateRotationReveal(INTRO_ROTATE_DUR); // defensive: guarantee the handoff ran even if a frame jumped straight past this whole window
      var zt = clamp01((tSince - INTRO_REVEAL_DUR) / INTRO_ZOOM_DUR);
      var e = easeInOutExpo(zt);
      var s = lerp(introRevealScale(), idleDialPx() / 1000, e);
      var dist = lerp(SAT_DIST_INTRO, SAT_DIST_FINAL, e);
      for (var i = 0; i < 6; i++) setSatellitePosition(i, dist, i * PROJECT_STEP);
      if (zt >= 1) finishIntro();
      return { x: 0, y: 0, s: s };
    }
    if (cameraMode === 'moving') {
      var t = clamp01((now - cameraMoveStart) / cameraMoveDur);
      var f = computeCameraMove(t, cameraFromPt, cameraToPt, cameraMoveScale, cameraMoveScale, cameraMoveDip);
      if (t >= 1) {
        cameraMode = 'idle';
        camTargetX = cameraToPt.x; camTargetY = cameraToPt.y;
        if (cameraOnDone) { var cb = cameraOnDone; cameraOnDone = null; cb(); }
      }
      return { x: f.x, y: f.y, s: f.scale };
    }
    return { x: camTargetX, y: camTargetY, s: idleDialPx() / 1000 };
  }

  /* ---------- explode (3-layer exploded view) state ---------- */

  var explodeProgress = 0; // 0 = flat, 1 = fully exploded (may transiently overshoot during the release spring)
  var explodeSnapMode = 'idle'; // 'idle' | 'snapping'
  var explodeSnapStart = 0, explodeSnapFrom = 0, explodeSnapTo = 0;

  function startExplodeSnap(target) {
    explodeSnapMode = 'snapping';
    explodeSnapStart = performance.now();
    explodeSnapFrom = explodeProgress;
    explodeSnapTo = target;
  }

  /* ---------- flip (front/back) state -- unchanged mechanism from before,
     just re-triggered by a horizontal swipe now instead of a double-click
     (see the gesture classifier below). Mutually exclusive with explode:
     the two are the dial's only "alternate states" and never run at once. ---------- */

  var flipProgress = 0; // 0 = front, 1 = back (may run mid-animation at any value in between)
  var flipAnimMode = 'idle'; // 'idle' | 'animating'
  var flipAnimStart = 0, flipAnimFrom = 0, flipAnimTo = 0;
  var FLIP_DUR = 700;
  var FLIP_DRAG_SPAN_FRAC = 0.5; // progress reaches 1 after dragging this fraction of screen width

  function startFlipAnim(target) {
    flipAnimMode = 'animating';
    flipAnimStart = performance.now();
    flipAnimFrom = flipProgress;
    flipAnimTo = target;
  }

  function toggleFlip() {
    if (globalPhase !== 'idle-center') return; // flip only makes sense at the flat center dial
    if (explodeProgress > 0.02) return; // mutual exclusion with the exploded view
    startFlipAnim(flipProgress < 0.5 ? 1 : 0);
  }

  // the back face has no equivalent click zone -- a plain double-click
  // anywhere on it flips back to the front.
  backFace.addEventListener('dblclick', function () {
    toggleFlip();
  });

  /* ---------- unified pointer-gesture handling: a single pointerdown/move/up
     sequence resolves (after GESTURE_COMMIT_PX of movement) into EITHER
     explode (vertical drag) OR flip (horizontal drag) -- never both. A
     short tap/click (movement<CLICK_SLOP_PX AND held<CLICK_MAX_MS) instead
     fires handleWindowClick on whichever project arc window it landed on.
     CLICK_SLOP_PX (6) and GESTURE_COMMIT_PX (14) are deliberately different
     numbers for two different questions ("was this basically a stationary
     click" vs "has the user clearly started dragging") -- collapsing them
     into one shared threshold is exactly what caused the real regression
     documented above GESTURE_COMMIT_PX's own declaration. ---------- */

  var CLICK_SLOP_PX = 6; // movement tolerance for still counting as a click, checked at release
  var CLICK_MAX_MS = 300;

  // which project window (if any) a screen point falls inside -- computed
  // GEOMETRICALLY (angle+radius from the dial's own live on-screen
  // bounding box, same `rect.width/1000` scale trick applyExplodeTransforms/
  // updateGuideLines already rely on) instead of asking the browser to hit-
  // test through e.target/closest('.proj-window'). This replaces the DOM-
  // target approach entirely: the title text and underline sitting on top
  // of the (invisible) window path, each one stacked inside its own
  // separately-transformed `.layer-group` (3D `preserve-3d`/`will-change:
  // transform` context), is exactly the kind of setup where different
  // browsers' pointer-events hit-testing through transparent/`pointer-
  // events:none` SVG content can disagree -- geometric hit-testing has no
  // such dependency at all, so it can't be broken by it.
  function hitTestProjectWindow(clientX, clientY) {
    var rect = dialStage.getBoundingClientRect();
    if (!rect.width) return -1;
    var cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    var scale = rect.width / 1000;
    var dx = clientX - cx, dy = clientY - cy;
    var radius = Math.sqrt(dx * dx + dy * dy) / scale;
    if (radius < RB_WIN_INNER || radius > RB_WIN_OUTER) return -1;
    var angle = normalizeDeg(Math.atan2(dx, -dy) * 180 / Math.PI);
    for (var i = 0; i < N; i++) {
      if (Math.abs(shortestDelta(i * PROJECT_STEP, angle)) <= TITLE_HIT_HALFWIDTH) return i;
    }
    return -1;
  }

  var activePointerId = null;
  var gesturePhase = 'none'; // 'none' | 'pending' | 'explode' | 'flip'
  var pendingDownX = 0, pendingDownY = 0, pendingDownTime = 0;
  var dragDownTargetIndex = -1; // which project window (if any) the gesture started on
  var explodeDragStartY = 0, explodeDragStartProgress = 0;
  var flipDragStartX = 0, flipDragStartProgress = 0;

  dialStage.addEventListener('pointerdown', function (e) {
    if (globalPhase !== 'idle-center') return; // gestures only make sense flat, at the center dial
    dialStage.setPointerCapture(e.pointerId);
    activePointerId = e.pointerId;
    gesturePhase = 'pending';

    pendingDownX = e.clientX; pendingDownY = e.clientY; pendingDownTime = performance.now();

    dragDownTargetIndex = hitTestProjectWindow(e.clientX, e.clientY);
    if (dragDownTargetIndex >= 0) setHover(dragDownTargetIndex); // mobile: invert instantly at tap-down

    explodeDragStartY = e.clientY; explodeDragStartProgress = explodeProgress;
    flipDragStartX = e.clientX; flipDragStartProgress = flipProgress;
  });

  dialStage.addEventListener('pointermove', function (e) {
    if (e.pointerId !== activePointerId) return;

    if (gesturePhase === 'pending') {
      // explode/flip are version-A-only gestures (see CENTER VERSION B) --
      // while version B is showing, a drag starting inside the dial never
      // resolves into either one (classifyDragGesture just keeps returning
      // null, so gesturePhase stays 'pending' and a short tap/click on a
      // ring title still works normally at release).
      var canExplode = flipProgress <= 0.02 && currentVersion === 'A';
      var canFlip = explodeProgress <= 0.02 && currentVersion === 'A';
      var decided = classifyDragGesture(e.clientX - pendingDownX, e.clientY - pendingDownY, explodeProgress > 0, canExplode, canFlip);
      if (decided === null) return;
      gesturePhase = decided;
      dialStage.classList.add('grabbing');
    }

    if (gesturePhase === 'explode') {
      var movedUp = explodeDragStartY - e.clientY; // positive = moved up
      explodeProgress = clamp01(explodeDragStartProgress + movedUp / (innerHeight * EXPLODE_DRAG_SPAN_FRAC));
      explodeSnapMode = 'idle'; // a live drag always overrides any in-flight snap
    } else if (gesturePhase === 'flip') {
      var movedLeft = flipDragStartX - e.clientX; // positive = moved left (front -> back)
      flipProgress = clamp01(flipDragStartProgress + movedLeft / (innerWidth * FLIP_DRAG_SPAN_FRAC));
      flipAnimMode = 'idle';
    }
  });

  function endPointerGesture(e) {
    if (e.pointerId !== activePointerId) return;
    dialStage.classList.remove('grabbing');
    try { dialStage.releasePointerCapture(activePointerId); } catch (err) { /* ignore */ }
    var endedPhase = gesturePhase;
    activePointerId = null; gesturePhase = 'none';

    if (endedPhase === 'pending') {
      // never committed to a drag gesture (movement stayed under
      // GESTURE_COMMIT_PX the whole time, which already covers the
      // "<CLICK_SLOP_PX-ish" click tolerance with margin to spare) --
      // only the time check is still needed here, to rule out a long,
      // mostly-stationary press
      var heldMs = performance.now() - pendingDownTime;
      if (dragDownTargetIndex >= 0 && heldMs < CLICK_MAX_MS) { handleWindowClick(dragDownTargetIndex); return; }
      // double-click/double-tap (A<->B version toggle, see CENTER VERSION
      // B): deliberately built on this SAME pointerdown/up click resolution
      // rather than the browser's native 'dblclick' event, since a native
      // dblclick isn't reliably synthesized for two fast taps on every
      // mobile browser (especially with the custom pointer-capture gesture
      // handling and site-wide touch-action:none already in play here) --
      // this way mouse double-click and a 300ms two-tap go through the
      // exact same code, both already time/slop-gated by the time this
      // click resolves at all.
      if (dragDownTargetIndex < 0 && heldMs < CLICK_MAX_MS) registerCenterTap(pendingDownX, pendingDownY);
      return;
    }
    if (endedPhase === 'explode') {
      startExplodeSnap(explodeProgress > EXPLODE_SNAP_THRESHOLD ? 1 : 0);
      return;
    }
    if (endedPhase === 'flip') {
      startFlipAnim(flipProgress > 0.5 ? 1 : 0);
    }
  }
  dialStage.addEventListener('pointerup', endPointerGesture);
  dialStage.addEventListener('pointercancel', endPointerGesture);

  /* ---------- hover (desktop) / tap (mobile, via pointerdown above) on a
     project arc window -- inverts that window to black/white and updates
     the bottom-right readout. Click/tap itself is handled in
     endPointerGesture -> handleWindowClick, not here. ---------- */

  var hoveredIndex = -1;
  function setHover(i) {
    if (hoveredIndex === i) return;
    hoveredIndex = i;
    for (var k = 0; k < N; k++) {
      var sel = k === i;
      projWindowEls[k].classList.toggle('selected', sel);
      projTitleEls[k].classList.toggle('selected', sel);
      projNumEls[k].classList.toggle('selected', sel);
      projUnderlineEls[k].classList.toggle('selected', sel);
    }
    selectReadout.textContent = i >= 0
      ? ('0' + (i + 1)).slice(-2) + ' / ' + ('0' + N).slice(-2) + ' ' + PROJECTS[i].title
      : '— / ' + ('0' + N).slice(-2);
  }
  // hover is now also computed geometrically (same hitTestProjectWindow as
  // the click target) via a plain mouse-move listener, rather than per-
  // element pointerenter/pointerleave on the SVG window paths -- for the
  // same reason the click target moved off e.target/closest(): robustness
  // against pointer-events hit-testing quirks through the layered/3D-
  // transformed SVG stack, not just DOM convenience. `mousemove` (not
  // `pointermove`) deliberately, so this never fights the active-gesture
  // pointermove listener above, and naturally only ever fires for an
  // actual mouse (never a touch tap, matching the old pointerType==
  // 'touch' guard this replaces).
  dialStage.addEventListener('mousemove', function (e) {
    if (globalPhase !== 'idle-center') { if (hoveredIndex !== -1) setHover(-1); return; }
    setHover(hitTestProjectWindow(e.clientX, e.clientY));
  });
  dialStage.addEventListener('mouseleave', function () { setHover(-1); });

  function handleWindowClick(index) {
    if (globalPhase !== 'idle-center') return;
    if (explodeProgress > 0.02 || flipProgress > 0.02) return; // "평면 앞면일 때만"
    moveCameraToSatellite(index);
  }

  window.addEventListener('keydown', function (e) {
    if (!projectPageEl.hidden) {
      if (e.key === 'Escape') { closeProject(); }
      return;
    }
    if (e.key === 'Escape' && flipProgress > 0.02) { toggleFlip(); return; }
    if (e.key === 'Escape' && explodeProgress > 0.02) { startExplodeSnap(0); return; }
    if (globalPhase === 'idle-sat') {
      if (e.key === 'Escape') { goBackToCenter(); return; }
      if (e.key === 'Enter') { handleSatelliteClick(focusedSatIndex); return; }
      if (e.key === 'ArrowLeft') { goToNeighborSatellite(-1); return; }
      if (e.key === 'ArrowRight') { goToNeighborSatellite(1); return; }
    }
  });

  /* ---------- guide dashed lines connecting layer seams at 0/120/240deg ---------- */

  var GUIDE_ANGLES = [0, 120, 240];
  var GUIDE_SEAM_12 = 320, GUIDE_SEAM_23 = INNER_CIRCLE_R;
  var guideLineEls = [];

  function buildGuideLines() {
    GUIDE_ANGLES.forEach(function (ang) {
      [[GUIDE_SEAM_12, 'z1', 'z2'], [GUIDE_SEAM_23, 'z2', 'z3']].forEach(function (spec) {
        var el = document.createElement('div');
        el.className = 'guide-line';
        guideLinesContainer.appendChild(el);
        var pt = polar(CX, CY, spec[0], ang);
        guideLineEls.push({ el: el, vx: pt[0], vy: pt[1], baseKey: spec[1], topKey: spec[2] });
      });
    });
  }
  buildGuideLines();

  function updateGuideLines(t) {
    var rect = dialStage.getBoundingClientRect();
    var scale = rect.width / 1000;
    for (var i = 0; i < guideLineEls.length; i++) {
      var g = guideLineEls[i];
      var baseZ = t[g.baseKey], topZ = t[g.topKey];
      var h = Math.max(0, topZ - baseZ);
      g.el.style.left = (g.vx * scale).toFixed(2) + 'px';
      g.el.style.top = (g.vy * scale).toFixed(2) + 'px';
      g.el.style.height = h.toFixed(2) + 'px';
      g.el.style.transform = 'translateZ(' + baseZ.toFixed(2) + 'px) rotateX(90deg)';
      g.el.style.opacity = t.guideOpacity.toFixed(3);
    }
  }

  function applyExplodeTransforms() {
    var rect = dialStage.getBoundingClientRect();
    var diameter = rect.width || 1;
    var t = computeExplodeTransforms(explodeProgress, diameter, innerWidth, innerHeight);

    explodeScene.style.transform =
      'translateY(' + t.translateY.toFixed(2) + 'px) scale(' + t.sceneScale.toFixed(4) + ') ' +
      'rotateX(' + t.rotateX.toFixed(3) + 'deg) rotateZ(' + t.rotateZ.toFixed(3) + 'deg)';
    layerGroup1.style.transform = 'translateZ(' + t.z1.toFixed(2) + 'px)';
    layerGroup2.style.transform = 'translateZ(' + t.z2.toFixed(2) + 'px)';
    layerGroup3.style.transform = 'translateZ(' + t.z3.toFixed(2) + 'px)';

    updateGuideLines(t);
  }

  /* ============================================================
     CENTER VERSION B -- an alternate "orbit sphere" view for the center
     portfolio circle only. Version A (the existing PORTFOLIO/subtitle/
     meta/name text built above) is untouched; this just adds a second
     thing that can occupy the same spot, toggled by double-clicking the
     empty area inside the small center circle (never the outer ring-B
     project titles, which live at a completely different radius and keep
     working exactly as before in either version).

     The "flip" between them is a 2D scaleX squash-to-a-sliver-and-back
     illusion (NOT a real CSS 3D rotateY) -- it reads the same visually for
     a flat circle this size, pivots around a well-defined, explicit origin
     on both the SVG side (#centerContent, see transform-box/transform-
     origin in style.css) and the HTML side (this plain div's own natural
     center), and sidesteps every cross-browser quirk around mixing real
     CSS 3D perspective with SVG content.
     ============================================================ */

  var centerContentEl = document.getElementById('centerContent');
  var centerV2El = document.getElementById('centerV2');
  var centerV2Canvas = document.getElementById('centerV2Canvas');
  var centerV2Ctx = centerV2Canvas.getContext('2d');
  var centerV2LabelsContainer = document.getElementById('centerV2Labels');

  // PORTFOLIO + subtitle, fixed (never rotates with the sphere) -- same
  // exact position/size/font/weight as version A's own title/subtitle,
  // read straight from centerContentLayout (set once in buildCenterContent)
  // rather than re-deriving them, so the two can never drift apart. Layer
  // order: inserted as a sibling BEFORE centerV2LabelsContainer within
  // #centerV2, so it paints above the canvas (sphere graphics) but below
  // every project label box, per spec.
  var centerV2FixedText = document.createElement('div');
  centerV2FixedText.id = 'centerV2FixedText';
  centerV2El.insertBefore(centerV2FixedText, centerV2LabelsContainer);
  function makeCenterV2FixedLine(text, y, size, fontVar, weight, uppercase) {
    var el = document.createElement('div');
    el.textContent = text;
    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.top = (y - CY) + 'px';
    el.style.transform = 'translate(-50%, -50%)';
    el.style.whiteSpace = 'nowrap';
    el.style.fontFamily = fontVar;
    el.style.fontWeight = String(weight);
    el.style.fontSize = size.toFixed(2) + 'px';
    el.style.color = '#111111';
    el.style.pointerEvents = 'none';
    if (uppercase) el.style.textTransform = 'uppercase';
    centerV2FixedText.appendChild(el);
    return el;
  }
  if (centerContentLayout) {
    makeCenterV2FixedLine(CENTER_TITLE, centerContentLayout.titleY, centerContentLayout.titleSize, 'var(--center-face)', 500, true);
    makeCenterV2FixedLine(CENTER_SUBTITLE, centerContentLayout.subtitleY, centerContentLayout.subtitleSize, 'var(--sans)', 400, false);
  }

  var CENTER_VERSION_KEY = 'npCenterVersion';
  var currentVersion = 'A'; // 'A' | 'B' -- the SETTLED version (mid-flip, see versionAnimFrom/To instead)
  var pendingStoredVersionB = false;
  try { pendingStoredVersionB = sessionStorage.getItem(CENTER_VERSION_KEY) === 'B'; } catch (e) { /* ignore */ }
  function persistCenterVersion(v) {
    try { sessionStorage.setItem(CENTER_VERSION_KEY, v); } catch (e) { /* ignore */ }
  }

  var VERSION_FLIP_DUR = 700;
  var versionAnimMode = 'idle'; // 'idle' | 'animating'
  var versionAnimStart = 0, versionAnimFrom = 'A', versionAnimTo = 'A', versionAnimSwapped = false;

  // shows exactly one of (A's SVG text) / (B's canvas+labels), with an
  // optional scaleX squash applied to whichever one is currently showing --
  // scaleX===1 means "settled, no transform at all" (cheaper + avoids any
  // stray sub-pixel blur from a no-op CSS transform sitting on the element).
  // every other version-A dial graphic besides the center text itself --
  // the outer bezel (ticks/numbers), ring A's fine scale, ring B (the 6
  // project titles/windows/dots/numbers), ring C's circle, and the mid
  // panel's own tick ring. All of it hides while version B is up (the
  // sphere now occupies the exact same full-dial real estate) and comes
  // back exactly as it was -- these groups are never touched otherwise, so
  // simply toggling `display` is lossless.
  function setOuterDialVisible(show) {
    var d = show ? '' : 'none';
    layer1Bg.style.display = d; bezelFixed.style.display = d; rotor.style.display = d;
    layer2Bg.style.display = d; layer2Fixed.style.display = d;
    layer3Bg.style.display = d;
  }
  function applyVersionTransform(which, scaleX) {
    var tf = (scaleX === 1) ? '' : ('scaleX(' + scaleX.toFixed(4) + ')');
    if (which === 'A') {
      centerContentEl.style.display = '';
      centerContentEl.style.transform = tf;
      centerV2El.style.display = 'none';
    } else {
      centerV2El.style.display = '';
      centerV2El.style.transform = tf;
      centerContentEl.style.display = 'none';
    }
    setOuterDialVisible(currentVersion === 'A');
  }
  function applyVersionVisibility() { applyVersionTransform(currentVersion, 1); }
  applyVersionVisibility(); // baseline: version A, no transform, B hidden

  function startVersionFlip(toVersion) {
    if (toVersion === currentVersion && versionAnimMode === 'idle') return;
    if (globalPhase !== 'idle-center') return;
    if (explodeProgress > 0.02 || flipProgress > 0.02) return; // flat front-face only, same guard as handleWindowClick
    versionAnimMode = 'animating';
    versionAnimStart = performance.now();
    versionAnimFrom = currentVersion;
    versionAnimTo = toVersion;
    versionAnimSwapped = false;
  }
  function toggleCenterVersion() { startVersionFlip(currentVersion === 'A' ? 'B' : 'A'); }

  // instant switch, no animation -- used once, right as the intro finishes,
  // to silently restore whatever version this session last left B in.
  function setCenterVersionInstant(v) {
    currentVersion = v;
    versionAnimMode = 'idle';
    applyVersionVisibility();
  }
  function applyStoredCenterVersionIfNeeded() {
    if (pendingStoredVersionB && currentVersion === 'A') setCenterVersionInstant('B');
  }

  function updateVersionFlip(now) {
    if (versionAnimMode !== 'animating') return;
    var t = clamp01((now - versionAnimStart) / VERSION_FLIP_DUR);
    var e = easeInOutCubic(t);
    var triangle = 1 - Math.abs(2 * e - 1); // 0 at e=0/1, 1 at e=0.5 -- the "edge-on" instant
    var scaleX = Math.cos(deg2rad(90 * triangle));
    if (!versionAnimSwapped && e >= 0.5) {
      currentVersion = versionAnimTo; // commit the content swap exactly at the sliver (scaleX==0 at this instant, so it's invisible)
      persistCenterVersion(currentVersion);
      versionAnimSwapped = true;
    }
    applyVersionTransform(e < 0.5 ? versionAnimFrom : versionAnimTo, scaleX);
    if (t >= 1) {
      versionAnimMode = 'idle';
      currentVersion = versionAnimTo;
      applyVersionVisibility();
    }
  }

  // a click anywhere in the empty center circle (radius <= INNER_CIRCLE_R,
  // deliberately far inside RB_WIN_INNER's 335, so a ring-B project-title
  // click can never reach here) -- two of them within CLICK_MAX_MS toggles
  // A<->B. Called from endPointerGesture, once a tap has ALREADY resolved
  // as "not on a ring title" and "short enough to be a click/tap at all."
  function hitTestCenterEmpty(clientX, clientY) {
    var rect = dialStage.getBoundingClientRect();
    if (!rect.width) return false;
    var cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    var scale = rect.width / 1000;
    var dx = clientX - cx, dy = clientY - cy;
    return (Math.sqrt(dx * dx + dy * dy) / scale) <= INNER_CIRCLE_R;
  }
  var lastCenterTapAt = -Infinity;
  function registerCenterTap(clientX, clientY) {
    if (globalPhase !== 'idle-center') return;
    if (explodeProgress > 0.02 || flipProgress > 0.02) return;
    if (!hitTestCenterEmpty(clientX, clientY)) return;
    var now = performance.now();
    if (now - lastCenterTapAt < CLICK_MAX_MS) {
      lastCenterTapAt = -Infinity; // consume -- a 3rd rapid tap starts a fresh pair, not an immediate 3rd toggle
      toggleCenterVersion();
    } else {
      lastCenterTapAt = now;
    }
  }

  /* ---------- sphere scene: orbit/label layout + orthographic draw ---------- */

  // the sphere now fills the WHOLE dial -- same radius as version A's own
  // outermost bezel circle, not the small inner panel anymore (the double-
  // click hit-zone in hitTestCenterEmpty() above is unrelated and stays on
  // INNER_CIRCLE_R deliberately, per spec -- only the sphere's own size changed).
  var SPHERE_R = BEZEL_OUTER1;
  var CANVAS_B_SIZE = SPHERE_R * 2 + 8;
  var SPHERE_LAT_DEGS = [-60, -30, 0, 30, 60];
  var SPHERE_LONG_DEGS = [0, 45, 90, 135, 180, 225, 270, 315];
  var SPHERE_TICK_COUNT = 7, SPHERE_TICK_SPEED = 6; // deg/sec, drifts the rim ticks around the circumference
  var SPHERE_LARGE_TILTS = [
    { pitch: deg2rad(58), roll: deg2rad(12) },
    { pitch: deg2rad(-48), roll: deg2rad(100) }
  ];
  var SPHERE_SMALL_TILT = { pitch: deg2rad(22), roll: deg2rad(-15) };
  var SPHERE_LARGE_SPEED = 6; // deg/sec -- full revolution ~60s ("천천히 공전")
  var SPHERE_SMALL_SPEED = 30; // deg/sec -- small orbits move faster, per spec
  var SPHERE_AXES = [[1, 0, 0], [0, 1, 0]]; // local unit axes drawn as dashed lines through center

  // 6 project labels, 3 per large orbit, evenly-ish spread -- project index
  // order matches PROJECTS/the ring-B titles exactly (ANOX...DRAWING), so
  // clicking label i moves the camera exactly like clicking ring title i.
  // Label box size/font stay fixed relative to the DIAL (not scaled up
  // further just because SPHERE_R grew) -- but per this turn's spec they're
  // themselves now ~2.5x bigger than before (font 15->32, padding 3px 6px
  // -> 8px 16px, point-to-box gap 8px -> 10px), so a label sitting right
  // out on the R-radius orbit can still stick out past the now-bigger-box's
  // own reach; see each entry's own `maxRadius` below.
  var SPHERE_LABEL_FONT = 32; // world units
  var SPHERE_LABEL_PAD_V = 8, SPHERE_LABEL_PAD_H = 16;
  var SPHERE_LABEL_GAP = 10; // point -> box placement offset (both x and y)
  var SPHERE_LABELS = [
    { project: 0, orbit: 0, phase: 20 },
    { project: 1, orbit: 1, phase: 60 },
    { project: 2, orbit: 0, phase: 150 },
    { project: 3, orbit: 1, phase: 190 },
    { project: 4, orbit: 0, phase: 270 },
    { project: 5, orbit: 1, phase: 310 }
  ];
  // each label's own estimated box size (used both to keep it off the
  // dial's edge -- see clampPointToReach in updateCenterVersionB, an EXACT
  // per-current-position pullback, not a flat worst-case radius, so a short
  // title's orbit isn't needlessly shrunk just because a longer one shares
  // the array) and its own dot diameter (7-9px, fixed/random -- picked once
  // here, never re-rolled per frame), slightly bigger than the plain
  // decorative ones below, per spec.
  SPHERE_LABELS.forEach(function (lbl) {
    var title = PROJECTS[lbl.project].title;
    lbl.boxW = title.length * SPHERE_LABEL_FONT * 0.62 + 2 * SPHERE_LABEL_PAD_H + 2; // ~glyph width + h-padding + border
    lbl.boxH = SPHERE_LABEL_FONT * 1.3 + 2 * SPHERE_LABEL_PAD_V + 2; // ~line height + v-padding + border
    lbl.dotSize = 7 + Math.random() * 2; // 7-9px diameter
  });
  var SPHERE_DECOR = [
    { kind: 'large', orbitIdx: 0, phase: 95, shape: 'dot' },
    { kind: 'large', orbitIdx: 1, phase: 260, shape: 'triangle' },
    { kind: 'small', radiusFrac: 0.45, phase: 10, shape: 'dot' },
    { kind: 'small', radiusFrac: 0.45, phase: 190, shape: 'triangle' },
    { kind: 'small', radiusFrac: 0.22, phase: 70, shape: 'dot' },
    { kind: 'small', radiusFrac: 0.22, phase: 250, shape: 'triangle' }
  ];
  // plain decorative dots (not the 6 labeled ones) get a fixed/random
  // diameter in 3-9px, picked once at build time rather than every frame.
  SPHERE_DECOR.forEach(function (d) { if (d.shape === 'dot') d.dotSize = 3 + Math.random() * 6; });

  function sphereTumbleAngles(tSec) {
    return {
      yaw: 0.6 * Math.sin(2 * Math.PI * tSec / 23) + 0.3 * Math.sin(2 * Math.PI * tSec / 11 + 1.3),
      pitch: 0.5 * Math.sin(2 * Math.PI * tSec / 19 + 2.1) + 0.25 * Math.sin(2 * Math.PI * tSec / 7 + 0.4),
      roll: 0.4 * Math.sin(2 * Math.PI * tSec / 27 + 0.7)
    };
  }
  // a point at `angleDeg` around a circle of `radius`, tilted by `tilt`
  // (fixed on the sphere's own body) then carried by the shared tumble
  // (yaw/pitch/roll) -- the one thing every rotating element below is built from.
  function orbitWorldPoint(radius, angleDeg, tilt, yaw, pitch, roll) {
    var local = circlePoint3(radius, angleDeg);
    var tilted = rotate3(local, 0, tilt.pitch, tilt.roll);
    return rotate3(tilted, yaw, pitch, roll);
  }

  function setupCenterV2Canvas() {
    var dpr = (typeof devicePixelRatio !== 'undefined' && devicePixelRatio) ? devicePixelRatio : 1;
    centerV2Canvas.width = CANVAS_B_SIZE * dpr;
    centerV2Canvas.height = CANVAS_B_SIZE * dpr;
    centerV2Canvas.style.width = CANVAS_B_SIZE + 'px';
    centerV2Canvas.style.height = CANVAS_B_SIZE + 'px';
    centerV2Canvas.style.left = (-CANVAS_B_SIZE / 2) + 'px';
    centerV2Canvas.style.top = (-CANVAS_B_SIZE / 2) + 'px';
    centerV2Ctx.setTransform(dpr, 0, 0, dpr, (CANVAS_B_SIZE / 2) * dpr, (CANVAS_B_SIZE / 2) * dpr);
  }
  setupCenterV2Canvas();

  function drawArrowhead(ctx, pA, pB, size) {
    var dx = pB[0] - pA[0], dy = pB[1] - pA[1];
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var ux = dx / len, uy = dy / len, px = -uy, py = ux;
    ctx.beginPath();
    ctx.moveTo(pA[0] + ux * size, pA[1] + uy * size);
    ctx.lineTo(pA[0] - ux * size * 0.5 + px * size * 0.5, pA[1] - uy * size * 0.5 + py * size * 0.5);
    ctx.lineTo(pA[0] - ux * size * 0.5 - px * size * 0.5, pA[1] - uy * size * 0.5 - py * size * 0.5);
    ctx.closePath();
    ctx.fillStyle = '#111111';
    ctx.fill();
  }

  // meta text corners (inside the circle): SELECTED WORKS / a randomized
  // barcode / a couple of slowly-breathing bars / a 10-digit code -- their
  // own random/periodic state lives on the paused versionBElapsedMs clock
  // too, so they freeze along with everything else while not visible.
  var sphereMeta = { barcodeBars: [], barcodeNextMs: 0, codeStr: '0000000000', codeNextMs: 0 };
  function regenBarcode() {
    var n = 5 + Math.floor(Math.random() * 6);
    var bars = [];
    for (var i = 0; i < n; i++) bars.push(1 + Math.random() * 2.5);
    sphereMeta.barcodeBars = bars;
  }
  function regenCode() {
    var s = '';
    for (var i = 0; i < 10; i++) s += Math.floor(Math.random() * 10);
    sphereMeta.codeStr = s;
  }
  regenBarcode(); regenCode();

  // the 4 meta corners sit near the circle's own inner edge, not at a
  // square-corner offset (which, at equal x/y insets, actually lands
  // OUTSIDE a circle -- sqrt(0.8^2+0.8^2) > 1 was the earlier version's
  // real overflow bug) -- MY is a small vertical inset from the top/bottom
  // edge (~12% of R) and MX is chosen so sqrt(MX^2+MY^2) stays safely
  // under R regardless of which corner.
  var SPHERE_META_MY = SPHERE_R * 0.88;
  var SPHERE_META_MX = SPHERE_R * 0.4;
  function drawSphereMeta(tSec) {
    var ctx = centerV2Ctx;
    ctx.save();
    ctx.font = '10px "IBM Plex Mono", monospace';
    ctx.fillStyle = '#111111';
    ctx.strokeStyle = '#111111';
    ctx.lineWidth = 1.5;
    var mx = SPHERE_META_MX, my = SPHERE_META_MY;

    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('SELECTED WORKS', -mx, -my);

    ctx.textAlign = 'right';
    var bx = mx;
    for (var i = sphereMeta.barcodeBars.length - 1; i >= 0; i--) {
      var w = sphereMeta.barcodeBars[i];
      ctx.fillRect(bx - w, -my, w, 10);
      bx -= w + 2;
    }

    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    var barLens = [0.5, 0.32, 0.2].map(function (base, i) {
      return (base + 0.06 * Math.sin(tSec * (0.15 + i * 0.07) + i * 2)) * SPHERE_R * 0.35;
    });
    var by = my - 14;
    [3, 2, 1].forEach(function (h, i) {
      ctx.fillRect(-mx, by, barLens[i], h);
      by += h + 4;
    });

    ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillText(sphereMeta.codeStr, mx, my);
    ctx.restore();
  }

  function drawSphereFrame(tSec, ang, labelPts) {
    var ctx = centerV2Ctx, R = SPHERE_R;
    ctx.clearRect(-CANVAS_B_SIZE / 2, -CANVAS_B_SIZE / 2, CANVAS_B_SIZE, CANVAS_B_SIZE);

    // face + border, same size as the sphere's own silhouette (R) -- the
    // whole dial-sized disc, not the small inner panel anymore. Pure white,
    // no grain (removed per spec -- was off-white + a 4%-alpha grain texture).
    ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.fillStyle = '#FFFFFF'; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = '#111111'; ctx.stroke();

    // 1. latitude/longitude wireframe -- opacity raised slightly (0.15->0.2)
    // so it still reads clearly against the now-pure-white face
    ctx.strokeStyle = '#111111'; ctx.lineWidth = 0.5; ctx.globalAlpha = 0.2;
    SPHERE_LAT_DEGS.forEach(function (lat) {
      ctx.beginPath();
      for (var th = 0; th <= 360; th += 10) {
        var w = rotate3([R * Math.cos(deg2rad(lat)) * Math.cos(deg2rad(th)), R * Math.cos(deg2rad(lat)) * Math.sin(deg2rad(th)), R * Math.sin(deg2rad(lat))], ang.yaw, ang.pitch, ang.roll);
        if (th === 0) ctx.moveTo(w[0], w[1]); else ctx.lineTo(w[0], w[1]);
      }
      ctx.stroke();
    });
    SPHERE_LONG_DEGS.forEach(function (lon) {
      ctx.beginPath();
      for (var ph = -90; ph <= 90; ph += 10) {
        var w = rotate3([R * Math.cos(deg2rad(ph)) * Math.cos(deg2rad(lon)), R * Math.cos(deg2rad(ph)) * Math.sin(deg2rad(lon)), R * Math.sin(deg2rad(ph))], ang.yaw, ang.pitch, ang.roll);
        if (ph === -90) ctx.moveTo(w[0], w[1]); else ctx.lineTo(w[0], w[1]);
      }
      ctx.stroke();
    });
    ctx.globalAlpha = 1;

    // 2. outer silhouette + drifting rim ticks (a sphere's own silhouette
    // under orthographic projection is always a flat circle of radius R,
    // regardless of rotation -- no 3D math needed for this part at all)
    ctx.lineWidth = 0.75;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();
    for (var i = 0; i < SPHERE_TICK_COUNT; i++) {
      var ta = deg2rad(i * (360 / SPHERE_TICK_COUNT) + tSec * SPHERE_TICK_SPEED);
      ctx.beginPath();
      ctx.moveTo(R * Math.cos(ta), R * Math.sin(ta));
      ctx.lineTo((R - 10) * Math.cos(ta), (R - 10) * Math.sin(ta));
      ctx.stroke();
    }

    // 3. two large tilted orbits (crossing great circles)
    ctx.lineWidth = 0.75;
    SPHERE_LARGE_TILTS.forEach(function (tilt) {
      ctx.beginPath();
      for (var a = 0; a <= 360; a += 7.5) {
        var w = orbitWorldPoint(R, a, tilt, ang.yaw, ang.pitch, ang.roll);
        if (a === 0) ctx.moveTo(w[0], w[1]); else ctx.lineTo(w[0], w[1]);
      }
      ctx.stroke();
    });

    // 4. two small concentric orbits, same plane
    [0.45, 0.22].forEach(function (frac) {
      ctx.beginPath();
      for (var a = 0; a <= 360; a += 10) {
        var w = orbitWorldPoint(R * frac, a, SPHERE_SMALL_TILT, ang.yaw, ang.pitch, ang.roll);
        if (a === 0) ctx.moveTo(w[0], w[1]); else ctx.lineTo(w[0], w[1]);
      }
      ctx.stroke();
    });

    // 5. dashed axes through center
    ctx.setLineDash([2, 4]);
    SPHERE_AXES.forEach(function (axis) {
      var p = rotate3([axis[0] * R * 0.92, axis[1] * R * 0.92, axis[2] * R * 0.92], ang.yaw, ang.pitch, ang.roll);
      ctx.beginPath(); ctx.moveTo(-p[0], -p[1]); ctx.lineTo(p[0], p[1]); ctx.stroke();
    });
    ctx.setLineDash([]);

    // 6. center "sun" marker
    ctx.beginPath(); ctx.arc(0, 0, R * 0.05, 0, Math.PI * 2); ctx.stroke();
    for (var k = 0; k < 6; k++) {
      var a2 = deg2rad(k * 60);
      ctx.beginPath();
      ctx.moveTo(R * 0.05 * Math.cos(a2), R * 0.05 * Math.sin(a2));
      ctx.lineTo(R * 0.09 * Math.cos(a2), R * 0.09 * Math.sin(a2));
      ctx.stroke();
    }

    // 7. decorative dots + a few directional arrowheads -- a point rotated
    // onto the sphere's far side (z<0, viewer looks down +z) shrinks to 0.8x
    // its own diameter and dims to 0.35 opacity, same rule as the labeled
    // points below and the DOM label boxes' own `.behind` class.
    SPHERE_DECOR.forEach(function (d) {
      var speed = d.kind === 'large' ? SPHERE_LARGE_SPEED : SPHERE_SMALL_SPEED;
      var a = d.phase + speed * tSec;
      var tilt = d.kind === 'large' ? SPHERE_LARGE_TILTS[d.orbitIdx] : SPHERE_SMALL_TILT;
      var radius = d.kind === 'large' ? R : R * d.radiusFrac;
      var w = orbitWorldPoint(radius, a, tilt, ang.yaw, ang.pitch, ang.roll);
      var behind = w[2] < 0;
      ctx.globalAlpha = behind ? 0.35 : 1;
      if (d.shape === 'dot') {
        var r = (d.dotSize / 2) * (behind ? 0.8 : 1);
        ctx.beginPath(); ctx.arc(w[0], w[1], r, 0, Math.PI * 2); ctx.fillStyle = '#111111'; ctx.fill();
      } else {
        var w2 = orbitWorldPoint(radius, a + 2, tilt, ang.yaw, ang.pitch, ang.roll);
        drawArrowhead(ctx, w, w2, 6 * (behind ? 0.8 : 1));
      }
      ctx.globalAlpha = 1;
    });

    // 8. the 6 labeled points themselves (their DOM label boxes are
    // positioned separately, from the same labelPts array, right after this call)
    labelPts.forEach(function (w, idx) {
      var behind = w[2] < 0;
      var r = (SPHERE_LABELS[idx].dotSize / 2) * (behind ? 0.8 : 1);
      ctx.globalAlpha = behind ? 0.35 : 1;
      ctx.beginPath(); ctx.arc(w[0], w[1], r, 0, Math.PI * 2); ctx.fillStyle = '#111111'; ctx.fill();
      ctx.globalAlpha = 1;
    });

    drawSphereMeta(tSec);
  }

  var sphereLabelEls = [];
  var sphereDescPosEls = [], sphereDescEls = [];
  var sphereHoveredLabel = -1;
  var sphereTimeScale = 1; // 0.3 while any label is hovered, per spec
  // which label's one-line description is currently showing -- desktop
  // hover sets this directly (so the very first click, while already
  // hovered, navigates immediately like before); on mobile (no real hover)
  // the first tap on a box sets it and shows the description, and a SECOND
  // tap on that SAME box (now that it matches) navigates instead.
  var sphereActiveDescIndex = -1;

  function showSphereDesc(idx) {
    // a tap on a different box while one description is already showing
    // (the mobile path -- no mouseleave ever fires to clean it up on its
    // own) must hide that PREVIOUS one, not just track the new index while
    // leaving the old description visibly stuck on screen.
    if (sphereActiveDescIndex !== -1 && sphereActiveDescIndex !== idx) {
      var prev = sphereDescEls[sphereActiveDescIndex];
      prev.style.transitionDuration = '0.12s';
      prev.classList.remove('visible');
    }
    sphereActiveDescIndex = idx;
    var d = sphereDescEls[idx];
    d.style.transitionDuration = '0.18s';
    d.classList.add('visible');
  }
  function hideSphereDesc(idx) {
    if (sphereActiveDescIndex === idx) sphereActiveDescIndex = -1;
    var d = sphereDescEls[idx];
    d.style.transitionDuration = '0.12s';
    d.classList.remove('visible');
  }
  function hideAllSphereDesc() {
    sphereDescEls.forEach(function (d) { d.style.transitionDuration = '0.12s'; d.classList.remove('visible'); });
    sphereActiveDescIndex = -1;
  }

  SPHERE_LABELS.forEach(function (lbl, idx) {
    var el = document.createElement('div');
    el.className = 'sphere-label';
    el.textContent = PROJECTS[lbl.project].title;
    el.style.fontSize = SPHERE_LABEL_FONT + 'px';
    el.style.padding = SPHERE_LABEL_PAD_V + 'px ' + SPHERE_LABEL_PAD_H + 'px';
    el.style.letterSpacing = '0.04em';
    centerV2LabelsContainer.appendChild(el);
    sphereLabelEls.push(el);

    // one-line description: a position-only outer wrapper (updated every
    // frame, no transition of its own -- transitioning a value that moves
    // every single frame would never settle) wrapping the actual fade/
    // slide-in content, whose CSS transition only ever reacts to the
    // `.visible` class toggling, never to the positioner's own movement.
    var descPos = document.createElement('div');
    descPos.className = 'sphere-desc-pos';
    var desc = document.createElement('div');
    desc.className = 'sphere-desc';
    desc.textContent = PROJECTS[lbl.project].oneLine || '';
    descPos.appendChild(desc);
    centerV2LabelsContainer.appendChild(descPos);
    sphereDescPosEls.push(descPos);
    sphereDescEls.push(desc);

    el.addEventListener('mouseenter', function () {
      sphereHoveredLabel = idx; sphereTimeScale = 0.3;
      el.classList.add('hovered');
      el.style.zIndex = '10'; // a hovered box always comes to front, even under heavy overlap
      showSphereDesc(idx);
    });
    el.addEventListener('mouseleave', function () {
      if (sphereHoveredLabel === idx) { sphereHoveredLabel = -1; sphereTimeScale = 1; }
      el.classList.remove('hovered');
      el.style.zIndex = '';
      hideSphereDesc(idx);
    });
    el.addEventListener('click', function (e) {
      e.stopPropagation();
      if (globalPhase !== 'idle-center' || currentVersion !== 'B') return;
      if (explodeProgress > 0.02 || flipProgress > 0.02) return;
      // mobile two-tap: first tap on a box shows its description and stops
      // there; a second tap on the SAME (already-showing) box navigates.
      // Desktop never actually hits the "show" branch on click at all --
      // mouseenter already called showSphereDesc before any click landed.
      if (sphereActiveDescIndex !== idx) { showSphereDesc(idx); return; }
      moveCameraToSatellite(lbl.project);
    });
  });

  // best-effort console warning if the Penelope font never actually loads
  // (the label's own font-family already falls back to Pretendard either way)
  try {
    if (document.fonts && document.fonts.ready && document.fonts.check) {
      document.fonts.ready.then(function () {
        if (!document.fonts.check('16px Penelope')) {
          console.warn('[center-v2] Penelope font not available -- sphere labels are rendering in the Pretendard fallback.');
        }
      });
    }
  } catch (e) { /* ignore */ }

  var versionBElapsedMs = 0, versionBLastNow = null;

  // runs the sphere's own simulated clock + redraw -- only while it's
  // actually possible to see (idle-center, and either B is the settled
  // version or a flip animation involving B is in flight); otherwise the
  // clock is explicitly paused (not just skipped-and-caught-up) so coming
  // back to it later resumes from exactly where it left off.
  function updateCenterVersionB(now) {
    var relevant = globalPhase === 'idle-center' && (currentVersion === 'B' || versionAnimMode === 'animating');
    if (!relevant) {
      versionBLastNow = null;
      if (sphereActiveDescIndex !== -1) hideAllSphereDesc(); // don't leave a description stuck visible off-screen
      return;
    }
    if (versionBLastNow === null) { versionBLastNow = now; return; } // first frame back -- no catch-up jump
    versionBElapsedMs += (now - versionBLastNow) * sphereTimeScale;
    versionBLastNow = now;

    if (versionBElapsedMs >= sphereMeta.barcodeNextMs) { regenBarcode(); sphereMeta.barcodeNextMs = versionBElapsedMs + 1000; }
    if (versionBElapsedMs >= sphereMeta.codeNextMs) { regenCode(); sphereMeta.codeNextMs = versionBElapsedMs + 2000; }

    var tSec = versionBElapsedMs / 1000;
    var ang = sphereTumbleAngles(tSec);

    var labelPts = SPHERE_LABELS.map(function (lbl) {
      var dir = lbl.orbit === 0 ? 1 : -1;
      var a = lbl.phase + dir * SPHERE_LARGE_SPEED * tSec;
      var p = orbitWorldPoint(SPHERE_R, a, SPHERE_LARGE_TILTS[lbl.orbit], ang.yaw, ang.pitch, ang.roll);
      // pulled radially inward -- exactly as far as THIS frame's own angle
      // actually requires, not a flat worst-case-for-every-angle radius --
      // whenever the box's far corner (GAP+boxW right, GAP+boxH up from the
      // dot) would otherwise cross the dial's edge.
      var offset = [SPHERE_LABEL_GAP + lbl.boxW, -(SPHERE_LABEL_GAP + lbl.boxH)];
      return clampPointToReach(p, offset, SPHERE_R);
    });

    drawSphereFrame(tSec, ang, labelPts);

    labelPts.forEach(function (w, idx) {
      var bx = w[0] + SPHERE_LABEL_GAP, by = w[1] - SPHERE_LABEL_GAP; // box's own bottom-left corner, in world space
      var el = sphereLabelEls[idx];
      el.style.transform = 'translate(' + bx.toFixed(1) + 'px,' + by.toFixed(1) + 'px) translateY(-100%)';
      el.classList.toggle('behind', w[2] < 0); // rotated onto the sphere's far side (viewer looks down +z)
      // description sits DESC_GAP (6px) below the box's own bottom edge,
      // left-aligned to the box's own left edge -- follows it every frame
      // regardless of whether it's currently showing.
      sphereDescPosEls[idx].style.transform = 'translate(' + bx.toFixed(1) + 'px,' + (by + 6).toFixed(1) + 'px)';
    });
  }

  /* ============================================================
     MAIN LOOP -- the only things this ever touches per frame are #world's
     transform, the --ink/--paper theme vars (only while the intro's zoom
     is in progress), and the existing explode/flip transforms. The SVG
     content itself is built once and never redrawn.
     ============================================================ */

  function frame(now) {
    var cf = currentCameraFrame(now);
    var vw = innerWidth, vh = innerHeight;
    // the stage-2 "fill the screen" zoom (see updateSatZoom) layers on top
    // of whatever scale currentCameraFrame returns -- it's 1 (a no-op)
    // everywhere except while parked at a satellite with its page open/
    // opening/closing, so multiplying it in unconditionally is safe.
    var finalScale = cf.s * updateSatZoom(now);
    worldEl.style.transform = 'translate(' + (vw / 2 - cf.x * finalScale).toFixed(2) + 'px,' + (vh / 2 - cf.y * finalScale).toFixed(2) + 'px) scale(' + finalScale.toFixed(5) + ')';
    updateSatUI();

    if (explodeSnapMode === 'snapping') {
      var et = clamp01((now - explodeSnapStart) / EXPLODE_SNAP_DUR);
      // easeOutBack is left un-clamped on purpose -- its own overshoot above 1
      // (or below 0) is exactly the "살짝 오버슈트" bounce the explode/collapse
      // spring is supposed to have, and it carries through computeExplodeTransforms
      explodeProgress = lerp(explodeSnapFrom, explodeSnapTo, easeOutBack(et));
      if (et >= 1) { explodeProgress = explodeSnapTo; explodeSnapMode = 'idle'; }
    }
    applyExplodeTransforms();

    if (flipAnimMode === 'animating') {
      var ft = clamp01((now - flipAnimStart) / FLIP_DUR);
      flipProgress = lerp(flipAnimFrom, flipAnimTo, easeInOutCubic(ft));
      if (ft >= 1) { flipProgress = flipAnimTo; flipAnimMode = 'idle'; }
    }
    flipStage.style.transform = 'rotateY(' + (flipProgress * 180).toFixed(3) + 'deg)';

    updateVersionFlip(now);
    updateCenterVersionB(now);

    requestAnimationFrame(frame);
  }

  /* ============================================================
     PROJECT PAGE + ROUTING + CAMERA-INTEGRATED ENTER/CLOSE/PREV/NEXT
     ============================================================ */

  var projectPageEl = document.getElementById('projectPage');
  var projectInner = document.getElementById('projectInner');
  var closeBtn = document.getElementById('closeBtn');
  var backBtn = document.getElementById('backBtn');
  var satPrevBtn = document.getElementById('satPrevBtn');
  var satNextBtn = document.getElementById('satNextBtn');
  var currentProjectIndex = -1;
  var PAGE_FADE_MS = 400; // matches .project-page's own CSS transition duration

  // which satellite (if any) the camera is currently resting on -- distinct
  // from currentProjectIndex, which means "that satellite's DETAIL PAGE is
  // open." You can be at a satellite (idle-sat, BACK/PREV/NEXT visible)
  // with no page open at all -- that's the whole point of splitting this
  // into two explicit stages.
  var focusedSatIndex = -1;

  /* ---------- stage-2 zoom: satellite (shown at normal dial size) ->
     fills the screen, in lockstep with the project page fading in on top.
     This is layered ON TOP of whatever currentCameraFrame already returns
     for the idle-sat camera position -- it only ever runs while the
     camera is holding still at a satellite, so multiplying it into the
     final scale unconditionally (see frame()) is safe everywhere else too
     (it's just 1 the rest of the time). ---------- */

  var satZoomFactorValue = 1; // authoritative current value -- persists across frames once an animation finishes, unlike a mode-reset
  var satZoomMode = 'idle'; // 'idle' | 'animating'
  var satZoomStart = 0, satZoomFrom = 1, satZoomTo = 1;
  var SAT_ZOOM_DUR = 500;

  function fillFactorValue() {
    // "화면을 꽉 채울 만큼" -- big enough that the circle's rendered
    // diameter exceeds the longer screen dimension, with a little overscan
    var fillScale = (1.1 * Math.max(innerWidth, innerHeight)) / D_UNIT;
    var idleScale = idleDialPx() / D_UNIT;
    return fillScale / idleScale;
  }
  function startSatZoom(toFactor) {
    satZoomMode = 'animating';
    satZoomStart = performance.now();
    satZoomFrom = satZoomFactorValue;
    satZoomTo = toFactor;
  }
  function updateSatZoom(now) {
    if (satZoomMode === 'animating') {
      var t = clamp01((now - satZoomStart) / SAT_ZOOM_DUR);
      satZoomFactorValue = lerp(satZoomFrom, satZoomTo, easeInOutCubic(t));
      if (t >= 1) { satZoomFactorValue = satZoomTo; satZoomMode = 'idle'; }
    }
    return satZoomFactorValue;
  }

  function makeMedia(src, label) {
    var div = document.createElement('div');
    div.className = 'proj-media';
    if (src) {
      var img = document.createElement('img');
      img.src = src;
      div.appendChild(img);
    } else {
      var num = document.createElement('span');
      num.className = 'proj-media-num';
      num.textContent = label;
      div.appendChild(num);
    }
    return div;
  }

  function renderProjectPage(index) {
    var p = PROJECTS[index];
    projectInner.innerHTML = '';

    var head = document.createElement('div');
    head.className = 'proj-head';
    var h1 = document.createElement('h1');
    h1.className = 'proj-head-title';
    h1.textContent = p.title;
    var meta = document.createElement('div');
    meta.className = 'proj-head-meta';
    var l1 = document.createElement('div');
    l1.textContent = ('0' + (index + 1)).slice(-2) + ' / ' + ('0' + N).slice(-2);
    var l2 = document.createElement('div');
    l2.textContent = [p.year, p.field].filter(Boolean).join(' · ') || '—';
    meta.appendChild(l1); meta.appendChild(l2);
    head.appendChild(h1); head.appendChild(meta);
    projectInner.appendChild(head);

    for (var i = 0; i < 4; i++) {
      var src = p.images && p.images[i] ? p.images[i] : (i === 0 ? p.cover : '');
      projectInner.appendChild(makeMedia(src, ('0' + (index + 1)).slice(-2) + '-' + (i + 1)));
    }

    var desc = document.createElement('p');
    desc.className = 'proj-desc';
    var lines = (p.desc && p.desc.length) ? p.desc : [
      '프로젝트 설명이 곧 추가됩니다.',
      '임시 텍스트입니다.',
      '임시 텍스트입니다.',
      '임시 텍스트입니다.',
      '임시 텍스트입니다.',
      '임시 텍스트입니다.'
    ];
    desc.innerHTML = lines.join('<br>');
    projectInner.appendChild(desc);

    var nav = document.createElement('div');
    nav.className = 'proj-nav';
    var prev = document.createElement('button');
    prev.type = 'button';
    prev.textContent = '← PREV';
    prev.addEventListener('click', function () { navigateProject(-1); });
    var next = document.createElement('button');
    next.type = 'button';
    next.textContent = 'NEXT →';
    next.addEventListener('click', function () { navigateProject(1); });
    nav.appendChild(prev); nav.appendChild(next);
    projectInner.appendChild(nav);
  }

  function navigateProject(dir) {
    var idx = (currentProjectIndex + dir + N) % N;
    location.hash = PROJECTS[idx].id;
  }

  function openProjectPageNow(index) {
    currentProjectIndex = index;
    renderProjectPage(index);
    projectPageEl.hidden = false;
    requestAnimationFrame(function () { projectPageEl.classList.add('visible'); });
  }

  // STAGE 1: dial-title click -- camera flies out to that project's
  // satellite and STOPS there. No page opens yet; the user must explicitly
  // click the (now screen-centered) satellite circle, or press Enter, to
  // continue to stage 2.
  function moveCameraToSatellite(index) {
    globalPhase = 'moving-to-sat';
    startCameraMove({ x: camTargetX, y: camTargetY }, SAT_POS[index], CAMERA_MOVE_DUR, function () {
      globalPhase = 'idle-sat';
      camTargetX = SAT_POS[index].x; camTargetY = SAT_POS[index].y;
      focusedSatIndex = index;
    });
  }

  // STAGE 2: click the arrived-at satellite (or Enter) -- it zooms to fill
  // the screen (startSatZoom) while the project page fades in on top via
  // the existing hash-routing (the hashchange handler's "page not open
  // yet" branch below just opens it directly, since the camera is already
  // exactly where it needs to be).
  function enterProjectDetail(index) {
    startSatZoom(fillFactorValue());
    try { location.hash = PROJECTS[index].id; } catch (e) { openProjectPageNow(index); }
  }
  function handleSatelliteClick(index) {
    if (globalPhase !== 'idle-sat' || focusedSatIndex !== index) return;
    if (currentProjectIndex !== -1) return; // already open
    enterProjectDetail(index);
  }

  // click/tap-vs-drag disambiguation for the satellite divs themselves --
  // same 6px/300ms rule as the dial titles, but simpler (no explode/flip
  // competing for the gesture here, so no need for the full pending/
  // explode/flip state machine).
  function wireSimpleClick(el, onClick) {
    var downX = 0, downY = 0, downTime = 0, down = false;
    el.addEventListener('pointerdown', function (e) { downX = e.clientX; downY = e.clientY; downTime = performance.now(); down = true; });
    el.addEventListener('pointerup', function (e) {
      if (!down) return;
      down = false;
      var dist = Math.sqrt(Math.pow(e.clientX - downX, 2) + Math.pow(e.clientY - downY, 2));
      if (dist < CLICK_SLOP_PX && performance.now() - downTime < CLICK_MAX_MS) onClick(e);
    });
    el.addEventListener('pointercancel', function () { down = false; });
  }
  satEls.forEach(function (el, i) {
    wireSimpleClick(el, function () { handleSatelliteClick(i); });
  });

  // BACK: satellite -> center, the exact reverse of moveCameraToSatellite.
  function goBackToCenter() {
    if (globalPhase !== 'idle-sat' || currentProjectIndex !== -1) return;
    var fromIdx = focusedSatIndex;
    globalPhase = 'moving-to-center';
    startCameraMove(SAT_POS[fromIdx], { x: 0, y: 0 }, CAMERA_MOVE_DUR, function () {
      globalPhase = 'idle-center';
      camTargetX = 0; camTargetY = 0;
      focusedSatIndex = -1;
    });
  }
  backBtn.addEventListener('click', goBackToCenter);

  // satellite-view PREV/NEXT: direct satellite<->satellite camera move,
  // no page involved, never through the center -- distinct from the
  // project PAGE's own PREV/NEXT (navigateProject below), which moves
  // between satellites WITH their pages open via the hash.
  function goToNeighborSatellite(dir) {
    if (globalPhase !== 'idle-sat' || currentProjectIndex !== -1) return;
    var fromIdx = focusedSatIndex;
    var toIdx = (fromIdx + dir + N) % N;
    globalPhase = 'moving-to-neighbor';
    startCameraMove(SAT_POS[fromIdx], SAT_POS[toIdx], CAMERA_MOVE_DUR, function () {
      globalPhase = 'idle-sat';
      camTargetX = SAT_POS[toIdx].x; camTargetY = SAT_POS[toIdx].y;
      focusedSatIndex = toIdx;
    });
  }
  satPrevBtn.addEventListener('click', function () { goToNeighborSatellite(-1); });
  satNextBtn.addEventListener('click', function () { goToNeighborSatellite(1); });

  // visible only while truly "parked" at a satellite with nothing covering
  // it -- updated every frame (cheap: two class toggles) so it's always in
  // sync with whatever just happened, rather than needing every call site
  // above to remember to call it.
  function updateSatUI() {
    var show = globalPhase === 'idle-sat' && currentProjectIndex === -1;
    backBtn.classList.toggle('visible', show);
    satPrevBtn.classList.toggle('visible', show);
    satNextBtn.classList.toggle('visible', show);
  }

  function closeProjectNow() {
    currentProjectIndex = -1;
    startSatZoom(1); // reverse the stage-2 zoom -- back to "parked at this satellite," NOT all the way to center (that's BACK's job)
    projectPageEl.classList.remove('visible');
    setTimeout(function () {
      projectPageEl.hidden = true;
    }, PAGE_FADE_MS);
  }

  function closeProject() {
    try { history.back(); } catch (e) { closeProjectNow(); }
  }
  closeBtn.addEventListener('click', closeProject);

  window.addEventListener('hashchange', function () {
    var h = location.hash.replace(/^#/, '');
    if (!h) { if (currentProjectIndex !== -1) closeProjectNow(); return; }
    var idx = PROJECTS.findIndex(function (p) { return p.id === h; });
    if (idx === -1) { if (currentProjectIndex !== -1) closeProjectNow(); return; }
    if (idx === currentProjectIndex) return;

    if (!projectPageEl.hidden) {
      // PREV/NEXT INSIDE the open project page: fade it out, snap the
      // zoom factor back to 1 (the satellite-to-satellite camera move
      // needs its own normal dip-and-pan, not the huge fill-screen
      // factor), then move the camera straight to the neighbor and open
      // its page -- never visiting the center.
      var fromIdx = currentProjectIndex;
      projectPageEl.classList.remove('visible');
      setTimeout(function () {
        projectPageEl.hidden = true;
        satZoomFactorValue = 1; satZoomMode = 'idle';
        globalPhase = 'moving-to-neighbor';
        startCameraMove(SAT_POS[fromIdx], SAT_POS[idx], CAMERA_MOVE_DUR, function () {
          globalPhase = 'idle-sat';
          camTargetX = SAT_POS[idx].x; camTargetY = SAT_POS[idx].y;
          focusedSatIndex = idx;
          // hash already equals idx (that's why we're here) -- setting it
          // again wouldn't fire another hashchange, so open directly
          startSatZoom(fillFactorValue());
          openProjectPageNow(idx);
        });
      }, PAGE_FADE_MS);
    } else {
      // page not open yet -- either stage 2's own hash set (camera/focus
      // ALREADY correct, see enterProjectDetail above) or a hash typed/
      // pasted directly: either way just open, no camera motion of its
      // own here (direct-entry's own camera jump is handled in INIT)
      globalPhase = 'idle-sat';
      camTargetX = SAT_POS[idx].x; camTargetY = SAT_POS[idx].y;
      focusedSatIndex = idx;
      openProjectPageNow(idx);
    }
  });

  /* ============================================================
     INIT
     ============================================================ */

  var initialHash = location.hash.replace(/^#/, '');
  var initialIndex = PROJECTS.findIndex(function (p) { return p.id === initialHash; });

  if (initialIndex !== -1) {
    // direct hash entry (#spora etc.): no intro, camera jumps straight there
    globalPhase = 'idle-sat';
    camTargetX = SAT_POS[initialIndex].x; camTargetY = SAT_POS[initialIndex].y;
    focusedSatIndex = initialIndex;
    satZoomFactorValue = fillFactorValue(); satZoomMode = 'idle';
    markMetaVisible();
    applyStoredCenterVersionIfNeeded();
    dialStage.style.transition = 'none'; dialStage.style.opacity = '1';
    satEls.forEach(function (el) { el.style.transition = 'none'; el.style.opacity = '1'; });
    setDialContentOpacity(1, false);
    setSatContentOpacity(1, false);
    rotationRevealStarted = true;
    introCanvas.style.display = 'none';
    openProjectPageNow(initialIndex);
  } else {
    globalPhase = 'intro';
    // repeat visits in the same session skip straight to the rotation
    // reveal (NI_T6) instead of compressing every stage proportionally --
    // offsetting introStart backward is enough, since every per-frame
    // function below already just reacts to "how far past introStart are
    // we," with no other special-casing needed
    introStart = performance.now() - (introSeenBefore ? NI_T6 : 0);
    setupIntroCanvas();
    initIntroHidden();
  }

  window.__dialDebug = {
    projects: PROJECTS,
    satPositions: SAT_POS,
    getGlobalPhase: function () { return globalPhase; },
    getCamTarget: function () { return { x: camTargetX, y: camTargetY }; },
    getCameraMode: function () { return cameraMode; },
    getHoveredIndex: function () { return hoveredIndex; },
    setHover: setHover,
    handleWindowClick: handleWindowClick,
    moveCameraToSatellite: moveCameraToSatellite,
    handleSatelliteClick: handleSatelliteClick,
    goBackToCenter: goBackToCenter,
    goToNeighborSatellite: goToNeighborSatellite,
    getFocusedSatIndex: function () { return focusedSatIndex; },
    getSatZoomFactor: function () { return satZoomFactorValue; },
    getSatZoomMode: function () { return satZoomMode; },
    isSatUIVisible: function () { return backBtn._classes ? backBtn._classes.indexOf('visible') >= 0 : backBtn.classList.contains('visible'); },
    projWindowCount: function () { return projWindowEls.length; },
    navigateProject: navigateProject,
    closeProject: closeProject,
    closeProjectNow: closeProjectNow,
    currentProjectIndex: function () { return currentProjectIndex; },
    getExplodeProgress: function () { return explodeProgress; },
    getExplodeSnapMode: function () { return explodeSnapMode; },
    getGesturePhase: function () { return gesturePhase; },
    startExplodeSnap: startExplodeSnap,
    getFlipProgress: function () { return flipProgress; },
    getFlipAnimMode: function () { return flipAnimMode; },
    toggleFlip: toggleFlip,
    skipIntro: skipIntro,
    getCenterVersion: function () { return currentVersion; },
    getCenterContentLayout: function () { return centerContentLayout; },
    getVersionAnimMode: function () { return versionAnimMode; },
    getVersionAnimFrom: function () { return versionAnimFrom; },
    getVersionAnimTo: function () { return versionAnimTo; },
    toggleCenterVersion: toggleCenterVersion,
    hitTestCenterEmpty: hitTestCenterEmpty,
    getVersionBElapsedMs: function () { return versionBElapsedMs; },
    getSphereHoveredLabel: function () { return sphereHoveredLabel; },
    getSphereTimeScale: function () { return sphereTimeScale; },
    sphereLabelEls: function () { return sphereLabelEls; },
    sphereDescEls: function () { return sphereDescEls; },
    sphereDescPosEls: function () { return sphereDescPosEls; },
    getActiveDescIndex: function () { return sphereActiveDescIndex; },
    getCenterV2FixedTextEls: function () { return centerV2FixedText.children; },
    sphereLabels: SPHERE_LABELS,
    sphereR: SPHERE_R,
    getOuterDialDisplay: function () { return bezelFixed.style.display; },
    introSeenBefore: introSeenBefore,
    getIntroCanvasHidden: function () { return introCanvasHidden; },
    getDialOpacity: function () { return dialStage.style.opacity; },
    introStageBounds: function () {
      return {
        t1: NI_T1, t2: NI_T2, t3: NI_T3, t4: NI_T4, t5: NI_T5, t6: NI_T6,
        reveal: INTRO_REVEAL_DUR, zoom: INTRO_ZOOM_DUR, rotateDur: INTRO_ROTATE_DUR
      };
    },
    getIntroStart: function () { return introStart; },
    getDialContentOpacity: function () { return bezelFixed.style.opacity; },
    getSatContentOpacity: function (i) { return satContentEls[i].style.opacity; },
    getRotationRevealStarted: function () { return rotationRevealStarted; },
    getSatWorldPos: function (i) {
      var el = satEls[i];
      return { x: parseFloat(el.style.left) + 500, y: parseFloat(el.style.top) + 500 };
    },
    satDistFinal: SAT_DIST_FINAL,
    satDistIntro: SAT_DIST_INTRO
  };

  requestAnimationFrame(frame);
})();
