import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { ALLOWED_VIDEO_CONTENT_TYPES } from '../videos.constants';

export class CreateVideoDto {
  /** Video title shown on the draft. */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  title: string;

  /** Original file name, used later as the download file name. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  file_name: string;

  /** Total file size in bytes, checked against VIDEO_MAX_SIZE_BYTES. */
  @IsInt()
  @Min(1)
  size_bytes: number;

  /** Browser-playable container accepted by the platform. */
  @IsIn(ALLOWED_VIDEO_CONTENT_TYPES)
  content_type: (typeof ALLOWED_VIDEO_CONTENT_TYPES)[number];
}
