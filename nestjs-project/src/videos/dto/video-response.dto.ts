import { ApiProperty } from '@nestjs/swagger';

export class VideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'aZ3kP9xQ2mB' })
  public_id: string;

  @ApiProperty({ example: 'My video' })
  title: string;

  @ApiProperty({ enum: ['draft', 'processing', 'ready', 'failed'] })
  status: string;

  @ApiProperty({ example: 'clip.mp4' })
  original_filename: string;

  @ApiProperty({ example: 'video/mp4' })
  content_type: string;

  @ApiProperty({ type: Number, nullable: true, example: 11534336 })
  size_bytes: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 3.0 })
  duration_seconds: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 1280 })
  width: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 720 })
  height: number | null;

  @ApiProperty({ type: String, nullable: true, example: 'h264' })
  video_codec: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Presigned thumbnail URL; null until a thumbnail exists',
  })
  thumbnail_url: string | null;

  @ApiProperty({ type: String, nullable: true })
  processing_error: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at: string;

  @ApiProperty({ format: 'date-time' })
  updated_at: string;
}
