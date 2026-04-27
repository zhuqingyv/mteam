import './AgentLogo.css';
import claudeLogo from '../../assets/agent-logos/claude.png';
import openaiLogo from '../../assets/agent-logos/openai.png';
import geminiLogo from '../../assets/agent-logos/gemini.png';
import aiderLogo from '../../assets/agent-logos/aider.png';
import cursorLogo from '../../assets/agent-logos/cursor.png';
import devinLogo from '../../assets/agent-logos/devin.png';
import replitLogo from '../../assets/agent-logos/replit.png';
import windsurfLogo from '../../assets/agent-logos/windsurf.png';
import amazonQLogo from '../../assets/agent-logos/amazon-q.png';
import copilotLogo from '../../assets/agent-logos/copilot.svg';
import fallbackLogo from '../../assets/logo-m.png';

interface AgentLogoProps {
  cliType: string;
  size?: number;
  grayscale?: boolean;
  className?: string;
}

const LOGO_URLS: Record<string, string> = {
  claude: claudeLogo,
  codex: openaiLogo,
  openai: openaiLogo,
  gpt: openaiLogo,
  gemini: geminiLogo,
  aider: aiderLogo,
  cursor: cursorLogo,
  devin: devinLogo,
  replit: replitLogo,
  windsurf: windsurfLogo,
  'amazon-q': amazonQLogo,
  copilot: copilotLogo,
};

function resolveUrl(cliType: string): string {
  return LOGO_URLS[cliType.toLowerCase()] ?? fallbackLogo;
}

export default function AgentLogo({ cliType, size = 24, grayscale = false, className }: AgentLogoProps) {
  const url = resolveUrl(cliType);
  const cls = ['agent-logo'];
  if (grayscale) cls.push('agent-logo--grayscale');
  if (className) cls.push(className);
  return (
    <img
      className={cls.join(' ')}
      src={url}
      width={size}
      height={size}
      alt={cliType}
      draggable={false}
    />
  );
}
