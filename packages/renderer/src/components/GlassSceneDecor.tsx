// GlassCard3D 的场景装饰：光源 + 粒子。
// 折射走自定义 ShaderMaterial 的屏幕空间采样（见 liquid-glass-shader.ts），
// 不再用 scene.environment，所以也没有 DesktopEnvBinder；光源只留给 Sparkles。
import { Sparkles } from '@react-three/drei';

export default function GlassSceneDecor() {
  return (
    <>
      <ambientLight intensity={0.6} />
      <spotLight
        position={[6, 7, 5]}
        intensity={1.4}
        angle={0.5}
        penumbra={0.7}
        color="#ffd2f3"
      />
      <spotLight
        position={[-6, -2, 4]}
        intensity={0.9}
        angle={0.6}
        penumbra={0.8}
        color="#9ec5ff"
      />
      <pointLight position={[0, 3, 2]} intensity={0.5} color="#fff0e8" />
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
    </>
  );
}
