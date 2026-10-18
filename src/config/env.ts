import { plainToInstance, Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export class Env {
  @IsIn(['development', 'production', 'test'])
  NODE_ENV: 'development' | 'production' | 'test' = 'development';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 4100;

  @IsUrl({ require_tld: false })
  FRONTEND_URL = 'http://localhost:3100';

  @IsString()
  DATABASE_URL: string;

  @IsString()
  @MinLength(32)
  JWT_ACCESS_SECRET: string;

  /** Время жизни access-токена в секундах */
  @Type(() => Number)
  @IsInt()
  @Min(60)
  JWT_ACCESS_TTL: number = 900;

  @IsString()
  @MinLength(20)
  OPENROUTER_API_KEY: string;
  @IsOptional() @IsString()
  DASHSCOPE_API_KEY?: string;
  @Transform(({ obj, key }) => obj[key] === true || obj[key] === 'true')
  @IsBoolean()
  DASHSCOPE_VOICE_ENABLED = false;

  @IsOptional() @IsString()
  DASHSCOPE_VOICE_API_KEY?: string;

  @Transform(({ value }) => value || undefined)
  @IsOptional() @IsUrl({ require_tld: false })
  DASHSCOPE_VOICE_BASE_URL?: string;

  @IsUrl({ require_tld:false })
  DASHSCOPE_BASE_URL = 'https://dashscope-intl.aliyuncs.com/api/v1';

  /** Дешёвая текстовая модель: перевод описаний в англоязычные промпты */
  @IsString()
  OPENROUTER_TEXT_MODEL = 'deepseek/deepseek-v4-flash';

  /** Каталог для сгенерированных файлов */
  @IsString()
  STORAGE_DIR = './storage';

  /** SMTP для транзакционных писем. Без SMTP_HOST в dev письма пишутся в STORAGE_DIR/mail-outbox как .eml */
  @IsOptional()
  @IsString()
  SMTP_HOST?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  SMTP_PORT: number = 587;

  /** true — TLS с первого байта (порт 465); false — STARTTLS */
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  SMTP_SECURE = false;

  @IsOptional()
  @IsString()
  SMTP_USER?: string;

  @IsOptional()
  @IsString()
  SMTP_PASS?: string;

  @IsString()
  MAIL_FROM = 'intexa-ai.com <support@intexa-ai.com>';

  /** Уведомления команды в Telegram. Без токена/чата события копятся в telegram_outbox */
  @IsOptional()
  @IsString()
  TG_BOT_TOKEN?: string;

  /** Для t.me/c/4333653026/… это -1004333653026 */
  @IsOptional()
  @IsString()
  TG_CHAT_ID?: string;

  /** Топик форума: первое число после id чата в ссылке t.me/c/<chat>/<topic>/<message> */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  TG_TOPIC_ID?: number;

  /** Время жизни refresh-токена в секундах */
  @Type(() => Number)
  @IsInt()
  @Min(3600)
  JWT_REFRESH_TTL: number = 60 * 60 * 24 * 30;
}

export function validateEnv(config: Record<string, unknown>): Env {
  const env = plainToInstance(Env, config, { enableImplicitConversion: true });
  const errors = validateSync(env, { skipMissingProperties: false });
  if (errors.length > 0) {
    const details = errors
      .map(
        (e) =>
          `${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`,
      )
      .join('\n');
    throw new Error(`Invalid environment variables:\n${details}`);
  }
  return env;
}
