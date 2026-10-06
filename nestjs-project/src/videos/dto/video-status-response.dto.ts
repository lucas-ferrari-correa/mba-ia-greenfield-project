import { ApiProperty } from '@nestjs/swagger';

export class VideoProcessingResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'processing' })
  status: string;
}
