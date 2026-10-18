import { createReadStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';

@Injectable()
export class StorageService {
  private readonly root: string;

  constructor(config: ConfigService<Env, true>) {
    this.root = resolve(config.get('STORAGE_DIR', { infer: true }));
  }

  /** Возвращает путь относительно корня хранилища */
  async save(
    userId: string,
    jobId: string,
    name: string,
    data: Buffer,
  ): Promise<string> {
    const relative = join(userId, jobId, name);
    const absolute = join(this.root, relative);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, data);
    return relative;
  }

  absolute(relative: string) {
    const absolute = resolve(this.root, relative);
    // Защита от выхода за пределы хранилища через ../ в сохранённом пути
    if (!absolute.startsWith(this.root + sep))
      throw new NotFoundException('File not found');
    return absolute;
  }
  stream(relative: string) {
    return createReadStream(this.absolute(relative));
  }

  async removeJob(userId: string, jobId: string): Promise<void> {
    await rm(join(this.root, userId, jobId), { recursive: true, force: true });
  }
}
