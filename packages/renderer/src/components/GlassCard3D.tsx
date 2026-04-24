// 3D 液态玻璃桌面宠物 —— R3F + drei + 自定义顶点 shader
//
// 效果目标：悬浮的液态玻璃圆角长方体，不规则流动变形 + 强折射 + 色散 + 光斑。
// 技术栈：
//   1. drei RoundedBox（args=[3,1.5,0.4] radius=0.3）做圆角长方体基础形状
//      smoothness/bevelSegments 调高，保证顶点变形时不出硬边
//   2. 顶点 shader 用 simplex noise 做流动变形（类似 MeshDistortMaterial 思路）
//   3. MeshTransmissionMaterial 做折射 + 色散 + 焦散 distortion
//   4. 对 drei MeshTransmissionMaterial 的 onBeforeCompile 做二次包装，
//      保留内部片段 shader 注入，同时追加自定义顶点 shader
//   5. Float 悬浮 + Sparkles 光斑 + Text 文字叠层
//   6. 点击后 300ms ease-out scale 放大动画，动画完成回调 onExpandDone 切到 ChatView
//
// Electron 透明：Canvas gl.alpha=true + style.transparent + html/body 透明（glass.css）
import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import {
  MeshTransmissionMaterial,
  RoundedBox,
  Float,
  Sparkles,
  Environment,
  Text,
} from '@react-three/drei';
import * as THREE from 'three';

type Props = {
  onExpandStart?: () => void;
  onExpandDone?: () => void;
};

// simplex noise GLSL —— 用于顶点 shader 做几何流动变形
// 来源：Ashima Arts simplex noise 3D，drei MeshDistortMaterial 同源
const NOISE_GLSL = `
  vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
  vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
  vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
  vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
  float snoise(vec3 v){
    const vec2 C=vec2(1.0/6.0,1.0/3.0);
    const vec4 D=vec4(0.0,0.5,1.0,2.0);
    vec3 i=floor(v+dot(v,C.yyy));
    vec3 x0=v-i+dot(i,C.xxx);
    vec3 g=step(x0.yzx,x0.xyz);
    vec3 l=1.0-g;
    vec3 i1=min(g.xyz,l.zxy);
    vec3 i2=max(g.xyz,l.zxy);
    vec3 x1=x0-i1+C.xxx;
    vec3 x2=x0-i2+C.yyy;
    vec3 x3=x0-D.yyy;
    i=mod289(i);
    vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
    float n_=0.142857142857;
    vec3 ns=n_*D.wyz-D.xzx;
    vec4 j=p-49.0*floor(p*ns.z*ns.z);
    vec4 x_=floor(j*ns.z);
    vec4 y_=floor(j-7.0*x_);
    vec4 xx=x_*ns.x+ns.yyyy;
    vec4 yy=y_*ns.x+ns.yyyy;
    vec4 h=1.0-abs(xx)-abs(yy);
    vec4 b0=vec4(xx.xy,yy.xy);
    vec4 b1=vec4(xx.zw,yy.zw);
    vec4 s0=floor(b0)*2.0+1.0;
    vec4 s1=floor(b1)*2.0+1.0;
    vec4 sh=-step(h,vec4(0.0));
    vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;
    vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
    vec3 p0=vec3(a0.xy,h.x);
    vec3 p1=vec3(a0.zw,h.y);
    vec3 p2=vec3(a1.xy,h.z);
    vec3 p3=vec3(a1.zw,h.w);
    vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
    p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
    vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
    m=m*m;
    return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
  }
`;

const EXPAND_DURATION_MS = 300;
const EXPAND_SCALE_TARGET = 2.4;

function LiquidGlass({
  expanding,
  onExpandDone,
  onClick,
}: {
  expanding: boolean;
  onExpandDone?: () => void;
  onClick: () => void;
}) {
  const materialRef = useRef<THREE.MeshPhysicalMaterial | null>(null);
  const groupRef = useRef<THREE.Group>(null);

  // 这些 uniform 我们自己拥有，跟 material.uniforms 合并进 shader
  const liquidUniforms = useMemo(
    () => ({
      uLiquidTime: { value: 0 },
      uLiquidStrength: { value: 0.1 }, // RoundedBox 段比 sphere 稀，位移量减半避免撕裂
      uLiquidFreq: { value: 1.8 },
      uLiquidSpeed: { value: 0.55 },
    }),
    [],
  );

  const expandStartTime = useRef<number | null>(null);
  const doneCalled = useRef(false);

  // 在 material ready 后，二次包装 onBeforeCompile。
  // drei 的 onBeforeCompile 由 useState 创建一次并绑定在实例上，
  // 我们先 call 原来的，再追加顶点 shader 的 noise 位移 + 法线同步扰动。
  useEffect(() => {
    const mat = materialRef.current;
    if (!mat) return;
    const original = mat.onBeforeCompile;
    mat.onBeforeCompile = function (shader, renderer) {
      original?.call(this, shader, renderer);

      shader.uniforms.uLiquidTime = liquidUniforms.uLiquidTime;
      shader.uniforms.uLiquidStrength = liquidUniforms.uLiquidStrength;
      shader.uniforms.uLiquidFreq = liquidUniforms.uLiquidFreq;
      shader.uniforms.uLiquidSpeed = liquidUniforms.uLiquidSpeed;

      // backside=true 时 onBeforeCompile 被调两次，防重复注入
      if (shader.vertexShader.includes('uLiquidTime')) return;

      shader.vertexShader =
        `
        uniform float uLiquidTime;
        uniform float uLiquidStrength;
        uniform float uLiquidFreq;
        uniform float uLiquidSpeed;
        ${NOISE_GLSL}
        ` + shader.vertexShader;

      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `
        float t = uLiquidTime * uLiquidSpeed;
        float n1 = snoise(position * uLiquidFreq + vec3(t, t * 0.7, t * 1.3));
        float n2 = snoise(position * uLiquidFreq * 2.4 + vec3(-t * 1.1, t * 0.4, -t * 0.8));
        float n = n1 * 0.7 + n2 * 0.3;
        vec3 transformed = position + normal * n * uLiquidStrength;
        `,
      );

      shader.vertexShader = shader.vertexShader.replace(
        '#include <beginnormal_vertex>',
        `
        #include <beginnormal_vertex>
        float nt = uLiquidTime * uLiquidSpeed;
        float nn = snoise(position * uLiquidFreq + vec3(nt, nt * 0.7, nt * 1.3));
        objectNormal = normalize(objectNormal + normal * nn * uLiquidStrength * 0.6);
        `,
      );
    };
    mat.needsUpdate = true;
  }, [liquidUniforms]);

  useFrame((state) => {
    liquidUniforms.uLiquidTime.value = state.clock.elapsedTime;

    // 展开动画：点击后 300ms ease-out cubic，scale 从 1 → EXPAND_SCALE_TARGET
    if (expanding && groupRef.current) {
      if (expandStartTime.current === null) {
        expandStartTime.current = state.clock.elapsedTime;
      }
      const elapsed =
        (state.clock.elapsedTime - expandStartTime.current) * 1000;
      const t = Math.min(elapsed / EXPAND_DURATION_MS, 1);
      // ease-out cubic：开始快、末尾缓
      const eased = 1 - Math.pow(1 - t, 3);
      const s = 1 + (EXPAND_SCALE_TARGET - 1) * eased;
      groupRef.current.scale.setScalar(s);
      // 展开时液态变形同步加剧，增强"绽放"感
      liquidUniforms.uLiquidStrength.value = 0.1 + 0.15 * eased;

      if (t >= 1 && !doneCalled.current) {
        doneCalled.current = true;
        onExpandDone?.();
      }
    }
  });

  return (
    <Float
      speed={expanding ? 0 : 1.6}
      rotationIntensity={expanding ? 0 : 0.18}
      floatIntensity={expanding ? 0 : 0.55}
    >
      <group ref={groupRef} onClick={onClick}>
        {/* 圆角长方体 3 : 1.5 : 0.4 扁长方体
            smoothness=10 / bevelSegments=8：段密，顶点 noise 变形时不出硬角
            creaseAngle=Math.PI：禁用边缘折痕，所有法线平滑，液态抖动不露面 */}
        <RoundedBox
          args={[3, 1.5, 0.4]}
          radius={0.3}
          smoothness={10}
          bevelSegments={8}
          creaseAngle={Math.PI}
        >
          <MeshTransmissionMaterial
            ref={materialRef as React.Ref<never>}
            transmission={0.95}
            roughness={0.12}
            thickness={0.4}
            ior={1.5}
            chromaticAberration={0.06}
            anisotropy={0.15}
            distortion={0.4}
            distortionScale={0.5}
            temporalDistortion={0.12}
            samples={6}
            resolution={512}
            backside={false}
            color="#e8e4f8"
            attenuationColor="#e0d8f0"
            attenuationDistance={2.5}
          />
        </RoundedBox>

        {/* 文字叠层 —— 长方体正前方，略微突出 */}
        <Text
          position={[0, 0.06, 0.3]}
          fontSize={0.18}
          color="#ffffff"
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.006}
          outlineColor="#6a5cff"
          outlineOpacity={0.7}
          material-toneMapped={false}
        >
          hi, i'm here with you
        </Text>
        <Text
          position={[0, -0.22, 0.3]}
          fontSize={0.11}
          color="#ffe8ff"
          anchorX="center"
          anchorY="middle"
          fillOpacity={0.88}
          material-toneMapped={false}
        >
          (^_^) mteam
        </Text>
      </group>
    </Float>
  );
}

export default function GlassCard3D({ onExpandStart, onExpandDone }: Props) {
  const [expanding, setExpanding] = useState(false);

  const handleClick = () => {
    if (expanding) return;
    setExpanding(true);
    onExpandStart?.();
  };

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        cursor: expanding ? 'default' : 'pointer',
      }}
    >
      <Canvas
        camera={{ position: [0, 0, 4.2], fov: 34 }}
        style={{ background: 'transparent' }}
        gl={{
          alpha: true,
          antialias: true,
          premultipliedAlpha: false,
          toneMapping: THREE.ACESFilmicToneMapping,
        }}
        dpr={[1, 2]}
      >
        <ambientLight intensity={0.8} />
        <spotLight
          position={[6, 7, 5]}
          intensity={1.6}
          angle={0.5}
          penumbra={0.7}
          color="#ffd2f3"
        />
        <spotLight
          position={[-6, -2, 4]}
          intensity={1.0}
          angle={0.6}
          penumbra={0.8}
          color="#9ec5ff"
        />
        <pointLight position={[0, 3, 2]} intensity={0.6} color="#fff0e8" />

        {/* 不用 Environment HDR — 折射暗色天空形成"黑板"。纯光照更通透 */}

        <LiquidGlass
          expanding={expanding}
          onExpandDone={onExpandDone}
          onClick={handleClick}
        />

        <Sparkles
          count={50}
          scale={[5.2, 2.6, 2.2]}
          size={4}
          speed={0.4}
          color="#ffc8ff"
          opacity={0.85}
        />
        <Sparkles
          count={26}
          scale={[4.2, 2.2, 1.8]}
          size={2.2}
          speed={0.25}
          color="#b8d4ff"
          opacity={0.65}
        />
      </Canvas>
    </div>
  );
}
