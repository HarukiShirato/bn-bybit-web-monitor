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
        // 极简终端风：纯黑底、纯白字、zinc 灰阶，颜色只留给有语义的数值
        brand: {
          dark: '#000000',             // 页面底色
          surface: '#000000',          // 卡片/表格与页面同色，靠边框分隔而不是色块
          surfaceHighlight: '#18181B', // zinc-900，只用于 hover
          border: '#27272A',           // zinc-800
          text: {
            primary: '#FFFFFF',
            secondary: '#A1A1AA',      // zinc-400
            muted: '#52525B',          // zinc-600
          },
          accent: '#FFFFFF',           // 强调 = 纯白，不再用币安黄
          success: '#10B981',          // emerald-500
          danger: '#F43F5E',           // rose-500
          info: '#0EA5E9',             // sky-500
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
