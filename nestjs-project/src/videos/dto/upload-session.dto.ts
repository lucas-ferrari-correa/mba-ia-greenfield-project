import { ApiProperty } from '@nestjs/swagger';

export class PresignedPartDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ example: 'http://localhost:9000/streamtube-videos/...' })
  url: string;
}

export class UploadedPartDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ example: '"5d41402abc4b2a76b9719d911017c592"' })
  etag: string;

  @ApiProperty({ example: 104857600 })
  size: number;
}

export class UploadInstructionsDto {
  @ApiProperty({ example: 104857600 })
  part_size: number;

  @ApiProperty({ example: 3 })
  part_count: number;

  @ApiProperty({ type: [PresignedPartDto] })
  parts: PresignedPartDto[];

  @ApiProperty({ format: 'date-time' })
  expires_at: string;
}

export class VideoDraftResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'aZ3kP9xQ2mB' })
  public_id: string;

  @ApiProperty({ example: 'My video' })
  title: string;

  @ApiProperty({ example: 'draft' })
  status: string;

  @ApiProperty({ type: UploadInstructionsDto })
  upload: UploadInstructionsDto;
}

export class UploadStateResponseDto {
  @ApiProperty({ example: 104857600 })
  part_size: number;

  @ApiProperty({ example: 3 })
  part_count: number;

  @ApiProperty({ type: [UploadedPartDto] })
  uploaded_parts: UploadedPartDto[];

  @ApiProperty({ type: [PresignedPartDto] })
  parts: PresignedPartDto[];

  @ApiProperty({ format: 'date-time' })
  expires_at: string;
}
