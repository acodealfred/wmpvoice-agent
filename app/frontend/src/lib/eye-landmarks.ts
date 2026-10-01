// MediaPipe iris/eyelid/corner landmark indices — one set per eye (subject's own
// left/right, per MediaPipe's canonical face-mesh numbering — FACEMESH_LEFT_IRIS is
// 474-477 around centre 473, FACEMESH_RIGHT_IRIS 469-472 around 468 — not the
// viewer's left/right). Every index in a set must belong to the SAME eye: an iris
// paired with the other eye's lids skews vertical gaze with any head tilt, and
// swaps which eye is reported as "left".
export const LEFT_EYE_LANDMARKS = { iris: 473, upperLid: 386, lowerLid: 374, innerCorner: 362, outerCorner: 263 };
export const RIGHT_EYE_LANDMARKS = { iris: 468, upperLid: 159, lowerLid: 145, innerCorner: 133, outerCorner: 33 };
