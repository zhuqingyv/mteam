// 果冻桌宠根组件：
//   .jelly-drag  —— 透明全窗口覆盖层，-webkit-app-region: drag 让用户能拖窗口
//   <JellyPet />  —— 3D 果冻 Canvas
//   .jelly-overlay —— HTML 文字叠层（表情 + 中文陪伴语）
import './styles/glass.css';
import { JellyPet } from './components/JellyPet';

export default function App() {
  return (
    <div className="jelly-root">
      <div className="jelly-drag" />
      <JellyPet />
      <div className="jelly-overlay">
        <div className="jelly-face">·ᴗ·</div>
        <div className="jelly-words">嗨嗨，我在这里陪你~</div>
      </div>
    </div>
  );
}
