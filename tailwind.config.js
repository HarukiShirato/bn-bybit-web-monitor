/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // 极简风（亮色）：白底、近黑字、zinc 灰阶，颜色只留给有语义的数值
        brand: {
          dark: '#FFFFFF',             // 页面底色
          surface: '#FFFFFF',          // 卡片/表格与页面同色，靠边框分隔而不是色块
          surfaceHighlight: '#F4F4F5', // zinc-100，只用于 hover
          border: '#E4E4E7',           // zinc-200
          text: {
            primary: '#18181B',        // zinc-900，比纯黑柔和一点
            secondary: '#52525B',      // zinc-600
            muted: '#A1A1AA',          // zinc-400
          },
          accent: '#18181B',           // 强调 = 近黑
          success: '#059669',          // emerald-600（亮底上 500 太浅）
          danger: '#E11D48',           // rose-600
          info: '#0284C7',             // sky-600
        }
      },
      fontFamily: {
        // 全站等宽：sans 也指向等宽栈，组件里的 font-sans / font-mono 落到同一字体
        sans: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
}
