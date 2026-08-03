import type { Metadata } from 'next'
import { Fira_Code } from 'next/font/google'
import './globals.css'

// 全站单一等宽字体（构建期自托管，不走外部 CDN）
const firaCode = Fira_Code({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  title: '永续合约数据仪表盘',
  description: 'Binance 和 Bybit 永续合约数据监控',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="zh-CN" className={firaCode.variable}>
      <body>{children}</body>
    </html>
  )
}
