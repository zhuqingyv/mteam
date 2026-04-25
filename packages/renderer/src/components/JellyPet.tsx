// 果冻桌宠 3D 组件：RoundedBox + MeshPhysicalMaterial（transmission/clearcoat）
// + 顶点 noise 蠕动（通过 onBeforeCompile 注入，保留 PBR 光照）
// + 一盏绕物体旋转的 SpotLight 做"糖面反光"游走的光带
import { useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Environment, RoundedBox } from '@react-three/drei';
import * as THREE from 'three';

function JellyMesh() {
  const meshRef = useRef<THREE.Mesh>(null);
  const spotRef = useRef<THREE.SpotLight>(null);
  const uTime = useRef({ value: 0 });

  // onBeforeCompile 把 noise 位移注入到内置 PBR 顶点 shader 里
  const material = useMemo(() => {
    const mat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color('#d4b0e8'),
      transmission: 0.15,
      roughness: 0.25,
      thickness: 2.0,
      ior: 1.45,
      clearcoat: 0.6,
      clearcoatRoughness: 0.2,
      transparent: true,
      opacity: 0.75,
      metalness: 0.05,
      envMapIntensity: 1.5,
    });

    const uAmp = { value: 0.04 };

    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uTime.current;
      shader.uniforms.uAmp = uAmp;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          /* glsl */ `
          #include <common>
          uniform float uTime;
          uniform float uAmp;

          float hash(vec3 p) {
            p = fract(p * vec3(443.897, 441.423, 437.195));
            p += dot(p, p.yzx + 19.19);
            return fract((p.x + p.y) * p.z);
          }
          float vnoise(vec3 p) {
            vec3 i = floor(p);
            vec3 f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            float n000 = hash(i);
            float n100 = hash(i + vec3(1, 0, 0));
            float n010 = hash(i + vec3(0, 1, 0));
            float n110 = hash(i + vec3(1, 1, 0));
            float n001 = hash(i + vec3(0, 0, 1));
            float n101 = hash(i + vec3(1, 0, 1));
            float n011 = hash(i + vec3(0, 1, 1));
            float n111 = hash(i + vec3(1, 1, 1));
            float nx00 = mix(n000, n100, f.x);
            float nx10 = mix(n010, n110, f.x);
            float nx01 = mix(n001, n101, f.x);
            float nx11 = mix(n011, n111, f.x);
            float nxy0 = mix(nx00, nx10, f.y);
            float nxy1 = mix(nx01, nx11, f.y);
            return mix(nxy0, nxy1, f.z) * 2.0 - 1.0;
          }
          `,
        )
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `
          float jn = vnoise(position * 1.6 + vec3(uTime * 0.3));
          vec3 transformed = position + normal * jn * uAmp;
          `,
        );
    };

    return mat;
  }, []);

  // 挂载后把自定义 material 赋给 RoundedBox 的 mesh
  useEffect(() => {
    if (meshRef.current) meshRef.current.material = material;
  }, [material]);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    uTime.current.value = t;
    if (spotRef.current) {
      const r = 3;
      spotRef.current.position.set(
        Math.cos(t * 0.35) * r,
        1.5 + Math.sin(t * 0.25) * 0.3,
        Math.sin(t * 0.35) * r,
      );
    }
  });

  return (
    <>
      <ambientLight intensity={0.45} />
      <pointLight position={[0, 2, 2]} intensity={0.6} color="#fff0f8" />
      <spotLight
        ref={spotRef}
        position={[3, 2, 0]}
        intensity={2.5}
        angle={0.7}
        penumbra={0.8}
        color="#ffd6ec"
        distance={8}
      />
      <RoundedBox
        ref={meshRef}
        args={[1.6, 1.2, 1.0]}
        radius={0.38}
        smoothness={8}
        creaseAngle={0.4}
      />
      <Environment preset="apartment" />
    </>
  );
}

export function JellyPet() {
  return (
    <Canvas
      camera={{ position: [0, 0, 3.2], fov: 38 }}
      gl={{ alpha: true, antialias: true, premultipliedAlpha: false }}
      style={{ background: 'transparent' }}
    >
      <JellyMesh />
    </Canvas>
  );
}
