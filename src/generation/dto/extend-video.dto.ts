import { IsUUID, IsString, IsIn, IsInt, Min, Max, MaxLength, MinLength } from 'class-validator';
export class ExtendVideoDto {
  @IsUUID() requestId: string;
  @IsString() @MinLength(1) @MaxLength(10000) description: string;
  @IsIn(['draft','standard','premium']) videoModel: string;
  @IsInt() @Min(2) @Max(60) duration: number;
  @IsInt() @Min(1) @Max(10000) expectedCredits: number;
}
