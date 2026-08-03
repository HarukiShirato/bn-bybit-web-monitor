import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { ICON_DIR } from '@/lib/iconStore';

export const dynamic = 'force-dynamic';

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  gif: 'image/gif',
};

/** 本地图标直出。文件名由服务端生成，这里仍然做白名单校验防路径穿越 */
export async function GET(
  _req: Request,
  { params }: { params: { file: string } }
) {
  const file = params.file;
  if (!/^[A-Za-z0-9_]+\.(png|jpg|webp|svg|gif)$/.test(file)) {
    return new NextResponse('bad request', { status: 400 });
  }

  const full = path.join(ICON_DIR, file);
  if (!full.startsWith(ICON_DIR) || !fs.existsSync(full)) {
    return new NextResponse('not found', { status: 404 });
  }

  const ext = file.split('.').pop()!;
  const body = fs.readFileSync(full);

  return new NextResponse(body, {
    headers: {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // 内容按 key 固定，永不改变，可以放心长缓存
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
