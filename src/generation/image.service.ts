import { BadRequestException, Injectable } from '@nestjs/common';
import sharp from 'sharp';

const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const ALLOWED_INPUT = ['image/jpeg', 'image/png', 'image/webp'];

export interface DecodedImage {
  buffer: Buffer;
  mimeType: string;
}

@Injectable()
export class ImageService {
  /** Проверяет data URL от пользователя и ужимает его до разумного размера для модели */
  async prepareInput(dataUrl: string): Promise<string> {
    const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
    if (!match)
      throw new BadRequestException('File must be sent as a data URL');

    const [, mimeType, base64] = match;
    if (!ALLOWED_INPUT.includes(mimeType)) {
      throw new BadRequestException('Only JPEG, PNG and WebP are supported');
    }
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.byteLength > MAX_INPUT_BYTES) {
      throw new BadRequestException('File is larger than 10 MB');
    }

    const normalized = await sharp(buffer)
      .rotate() // учитываем EXIF-поворот с телефона
      .resize({
        width: 1536,
        height: 1536,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 90 })
      .toBuffer();

    return `data:image/jpeg;base64,${normalized.toString('base64')}`;
  }

  /** Вписывает результат в требуемый размер площадки, добирая поля белым */
  async fitTo(
    buffer: Buffer,
    width: number,
    height: number,
  ): Promise<DecodedImage> {
    const output = await sharp(buffer)
      .resize({ width, height, fit: 'contain', background: '#ffffff' })
      .jpeg({ quality: 92 })
      .toBuffer();
    return { buffer: output, mimeType: 'image/jpeg' };
  }

  /**
   * Заголовок и подпись рисуем сами: генеративные модели пишут русский текст с ошибками.
   * Это же даёт точное соответствие требованиям площадки.
   */
  async overlayCaption(
    buffer: Buffer,
    title: string,
    subtitle: string | null,
  ): Promise<DecodedImage> {
    const image = sharp(buffer);
    const { width = 900, height = 1200 } = await image.metadata();

    const padding = Math.round(width * 0.06);
    const subtitleSize = Math.round(width * 0.045);
    const available = width - padding * 2;

    // Подбираем кегль так, чтобы заголовок уместился максимум в три строки и не вылез за поле
    let titleSize = Math.round(width * 0.075);
    let lines = this.wrapToWidth(title, available, titleSize);
    while (lines.length > 3 && titleSize > Math.round(width * 0.04)) {
      titleSize = Math.round(titleSize * 0.9);
      lines = this.wrapToWidth(title, available, titleSize);
    }
    lines = lines.slice(0, 3);
    const blockHeight =
      padding * 2 +
      lines.length * titleSize * 1.2 +
      (subtitle ? subtitleSize * 1.6 : 0);

    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${width}" height="${Math.round(blockHeight)}" fill="#ffffff" fill-opacity="0.92"/>
  ${lines
    .map(
      (line, index) =>
        `<text x="${padding}" y="${padding + titleSize * (0.95 + index * 1.2)}" font-family="DejaVu Sans, sans-serif" font-size="${titleSize}" font-weight="700" fill="#141413">${this.escape(line)}</text>`,
    )
    .join('\n  ')}
  ${
    subtitle
      ? `<text x="${padding}" y="${padding + titleSize * (0.95 + lines.length * 1.2) + subtitleSize * 0.4}" font-family="DejaVu Sans, sans-serif" font-size="${subtitleSize}" fill="#5B3DF5">${this.escape(subtitle)}</text>`
      : ''
  }
</svg>`;

    const output = await image
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .jpeg({ quality: 92 })
      .toBuffer();
    return { buffer: output, mimeType: 'image/jpeg' };
  }

  async describe(buffer: Buffer): Promise<{ width?: number; height?: number }> {
    const { width, height } = await sharp(buffer).metadata();
    return { width, height };
  }

  /**
   * Перенос по ширине, а не по числу символов: у кириллицы в DejaVu Sans Bold
   * средняя ширина знака примерно 0.62 кегля, заглавные шире.
   */
  private wrapToWidth(
    text: string,
    maxWidth: number,
    fontSize: number,
  ): string[] {
    const charWidth = fontSize * 0.62;
    const perLine = Math.max(6, Math.floor(maxWidth / charWidth));
    const words = text.trim().split(/\s+/);
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
      if (current && (current + ' ' + word).length > perLine) {
        lines.push(current);
        current = word;
      } else {
        current = current ? `${current} ${word}` : word;
      }
    }
    if (current) lines.push(current);
    return lines;
  }

  private escape(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
