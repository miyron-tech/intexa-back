import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { SERVICE_IDS, type ServiceId } from '../services.catalog.js';

export class CreateJobDto {
  @IsUUID()
  requestId: string;

  @IsInt() @Min(1) @Max(100000)
  expectedCredits: number;

  @IsIn(SERVICE_IDS as unknown as string[])
  service: ServiceId;

  @IsString()
  @MaxLength(40)
  preset: string;

  /** Описание товара или сцены на русском */
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  description?: string;

  /** Исходные изображения в виде data URL */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsString({ each: true })
  inputs?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(4)
  count?: number;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  marketplace?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  aspectRatio?: string;

  /** Заголовок для инфографики — накладывается нами поверх картинки */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  badge?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  videoModel?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(60)
  duration?: number;

  @IsOptional() @IsString() @MaxLength(7000000)
  voiceReference?: string;

  /** Подтверждение прав на фото человека */
  @IsOptional()
  @IsBoolean()
  consent?: boolean;
}
