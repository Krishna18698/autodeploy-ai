# 7. Hand-written WebGL for the landing background

Status: accepted · 2026-10

One full-screen fragment shader draws the ribbons. Three.js/R3F would add a
scene graph and ~150 KB for a single quad. The shader pauses off-screen and
in hidden tabs, caps device pixel ratio, uses fewer strands on touch devices,
and falls back to a static gradient without WebGL or with reduced motion.
