// 液态玻璃桌面宠物：R3F + 自定义 ShaderMaterial 做屏幕空间折射。
// shader 在 liquid-glass-shader.ts；桌面纹理/rect 通过 useDesktopTexture 拿。
import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { RoundedBox, Float, Text } from '@react-three/drei';
import * as THREE from 'three';
import GlassSceneDecor from './GlassSceneDecor';
import { useDesktopTexture } from './useDesktopTexture';
import {
  createLiquidGlassMaterial,
  LiquidGlassUniforms,
} from './liquid-glass-shader';

type Props = {
  onExpandStart?: () => void;
  onExpandProgress?: (t: number) => void;
  onExpandDone?: () => void;
};

const STRETCH_DURATION_MS = 600;
const BOX_FROM = new THREE.Vector3(3.0, 1.5, 0.4);
const BOX_TO = new THREE.Vector3(6.0, 4.0, 0.3);

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

function LiquidGlass({
  expanding,
  onExpandProgress,
  onExpandDone,
  onClick,
}: {
  expanding: boolean;
  onExpandProgress?: (t: number) => void;
  onExpandDone?: () => void;
  onClick: () => void;
}) {
  // 创建 material 一次即可；uniforms 对象直接访问修改（shader 会看到最新值）
  const material = useMemo(() => createLiquidGlassMaterial(), []);
  const u = material.uniforms as unknown as LiquidGlassUniforms;
  // BOX_FROM/BOX_TO 在组件侧单一维护，传给 shader 做 morph
  u.uBoxFrom.value.copy(BOX_FROM);
  u.uBoxTo.value.copy(BOX_TO);

  const { size, gl } = useThree();
  const { texture, winRectUV, imgAspect, dispAspect } = useDesktopTexture();

  // 低频（壁纸换 / 分辨率变）→ useEffect 一次性写 uniform
  useEffect(() => {
    u.uDesktop.value = texture;
    u.uHasDesktop.value = texture ? 1 : 0;
  }, [texture, u]);
  useEffect(() => {
    u.uImgAspect.value = imgAspect;
  }, [imgAspect, u]);
  // 高频（拖动 60Hz）→ useFrame 里读 ref 写 uniform，避免 React re-render 链
  useEffect(() => {
    // gl_FragCoord 是 drawing buffer 像素坐标。直接用 canvas domElement 的
    // width/height 最可靠 —— 比推算 CSS size × devicePixelRatio 保险，避免
    // R3F dpr clamp 跟真实 pixelRatio 不一致导致的 UV 缩放错误（之前偏到
    // 左下角小块的根因就是这个）。
    const canvas = gl.domElement;
    u.uResolution.value.set(canvas.width, canvas.height);
  }, [size, gl, u]);

  useEffect(() => () => material.dispose(), [material]);

  const expandStartTime = useRef<number | null>(null);
  const doneCalled = useRef(false);

  useFrame((state) => {
    u.uTime.value = state.clock.elapsedTime;
    // 每帧从 ref 拉最新 winRectUV / dispAspect 写入 uniform（0 次 React 渲染）
    u.uWinRect.value.copy(winRectUV.current);
    u.uDispAspect.value = dispAspect.current;

    if (expanding) {
      if (expandStartTime.current === null) {
        expandStartTime.current = state.clock.elapsedTime;
      }
      const elapsed =
        (state.clock.elapsedTime - expandStartTime.current) * 1000;
      const t = Math.min(elapsed / STRETCH_DURATION_MS, 1);
      const eased = easeOutCubic(t);

      u.uStretchT.value = eased;

      // 钟形强度曲线：拉伸中段液态最剧烈，末段平静
      let strength: number;
      if (t < 0.15) strength = 0.1 + (0.35 - 0.1) * (t / 0.15);
      else if (t < 0.85)
        strength = 0.35 - (0.35 - 0.28) * ((t - 0.15) / 0.7);
      else strength = 0.28 - (0.28 - 0.12) * ((t - 0.85) / 0.15);
      u.uLiquidStrength.value = strength;

      onExpandProgress?.(t);

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
      <group onClick={onClick}>
        <RoundedBox
          args={[BOX_FROM.x, BOX_FROM.y, BOX_FROM.z]}
          radius={0.3}
          smoothness={10}
          bevelSegments={8}
          creaseAngle={Math.PI}
          material={material}
        />

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

export default function GlassCard3D({
  onExpandStart,
  onExpandProgress,
  onExpandDone,
}: Props) {
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
        position: 'relative',
      }}
    >
      {/* 拖拽层：覆盖 Canvas 上方，让窗口可拖动。点击穿透给 Canvas 处理展开。 */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 10,
          // @ts-expect-error -- Electron 专属 CSS
          WebkitAppRegion: 'drag',
        }}
        onDoubleClick={handleClick}
      />
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
        <GlassSceneDecor />
        <LiquidGlass
          expanding={expanding}
          onExpandProgress={onExpandProgress}
          onExpandDone={onExpandDone}
          onClick={handleClick}
        />
      </Canvas>
    </div>
  );
}
