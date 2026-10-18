import {
  IsEmail,
  IsInt,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
export class UpdatePlanDto {
  @IsInt() @Min(0) @Max(10000000) monthlyCents: number;
  @IsInt() @Min(0) @Max(10000000) annualMonthlyCents: number;
  @IsInt() @Min(0) @Max(10000000) credits: number;
  @IsInt() @Min(1) version: number;
}
export class TopUpDto {
  @IsUUID() requestId: string;
  @IsEmail() @MaxLength(320) email: string;
  @IsInt() @Min(1) @Max(10000000) amountCents: number;
  @IsInt() @Min(1) @Max(10000000) credits: number;
  @IsString() @MinLength(3) @MaxLength(500) note: string;
}
