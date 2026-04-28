export const VERT_SHADER = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0, 1); }
`;

export const FRAG_SHADER = `#version 300 es
precision highp float;

uniform vec2 u_res;
uniform float u_time;
uniform float u_dpr;
uniform int u_tentCount;
uniform vec4 u_tent[64];

out vec4 o_color;

const float CORNER_R_BASE = 12.0;
const float BW_BASE = 4.0;
const int BEZIER_SAMPLES = 32;

float roundedBoxSDF(vec2 p, vec4 box, float cr) {
    vec2 center = box.xy + box.zw * 0.5;
    vec2 d = abs(p - center) - box.zw * 0.5 + cr;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - cr;
}

vec2 bezierAt(vec2 p0, vec2 p1, vec2 p2, vec2 p3, float t) {
    float it = 1.0 - t;
    return it*it*it*p0 + 3.0*it*it*t*p1 + 3.0*it*t*t*p2 + t*t*t*p3;
}

vec3 tentacleSDF(vec2 p, vec2 p0, vec2 p1, vec2 p2, vec2 p3,
                 float reach, float headPos, float tailPos, float bw) {
    float minDist = 1e10;
    float bestT = 0.0;
    float span = headPos - tailPos;
    if (span < 0.001) return vec3(1e10, 0.0, 0.0);

    for (int i = 0; i <= BEZIER_SAMPLES; i++) {
        float t = tailPos + float(i) / float(BEZIER_SAMPLES) * span;
        vec2 b = bezierAt(p0, p1, p2, p3, t);
        float d = length(p - b);
        if (d < minDist) { minDist = d; bestT = t; }
    }

    float rootW = bw * 1.2;
    float midW = bw * 0.35;
    float ef = 4.0 * (bestT - 0.5) * (bestT - 0.5);
    float w = midW + (rootW - midW) * ef;

    float headFade = smoothstep(headPos, headPos - 0.12, bestT);
    float tailFade = smoothstep(tailPos, tailPos + 0.12, bestT);
    w *= headFade * tailFade;

    float sdfDist = minDist - w * min(reach * 1.5, 1.0);
    return vec3(sdfDist, bestT, 0.0);
}

void main() {
    vec2 px = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);
    float cr = CORNER_R_BASE * u_dpr;
    float bw = BW_BASE * u_dpr;

    if (u_tentCount == 0) discard;

    float bestDist = 1e10;
    vec3 bestColor = vec3(0.0);

    for (int ti = 0; ti < 8; ti++) {
        if (ti >= u_tentCount) break;
        int base = ti * 8;

        vec2 p0 = u_tent[base + 0].xy;
        vec2 p1 = u_tent[base + 0].zw;
        vec2 p2 = u_tent[base + 1].xy;
        vec2 p3 = u_tent[base + 1].zw;
        float reach = u_tent[base + 2].x;
        float headPos = u_tent[base + 2].y;
        float tailPos = u_tent[base + 2].z;
        float fuseSrc = u_tent[base + 2].w;
        vec3 cA = u_tent[base + 3].xyz;
        float fuseDst = u_tent[base + 3].w;
        vec3 cB = u_tent[base + 4].xyz;

        vec3 res = tentacleSDF(px, p0, p1, p2, p3, reach, headPos, tailPos, bw);
        float d = res.x;

        if (d < bestDist) {
            bestDist = d;
            float t = res.y;
            bestColor = mix(cA, cB, smoothstep(0.0, 1.0, t));
        }
    }

    float edge = 2.0 * u_dpr;
    float val = 1.0 - smoothstep(-edge, edge, bestDist);
    if (val < 0.01) discard;

    o_color = vec4(bestColor * val, val);
}
`;
