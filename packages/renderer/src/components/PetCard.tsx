// 收起态：桌面宠物悬浮卡片
// 形态参考 design-pet-states.jpeg 中每格左下角那张：emoji face + 一行短文案
// 整体可拖拽（-webkit-app-region: drag），点击展开聊天窗口

type Props = {
  face: string;
  text: string;
  onClick: () => void;
};

export default function PetCard({ face, text, onClick }: Props) {
  return (
    <div className="pet-root">
      <button className="pet-bubble" onClick={onClick} type="button">
        <span className="pet-face" aria-hidden>
          {face}
        </span>
        <span className="pet-text">{text}</span>
      </button>
    </div>
  );
}
