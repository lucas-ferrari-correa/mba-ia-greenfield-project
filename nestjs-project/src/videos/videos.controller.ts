import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { VideoProcessingResponseDto } from './dto/video-status-response.dto';
import {
  UploadStateResponseDto,
  VideoDraftResponseDto,
} from './dto/upload-session.dto';
import { VideosService } from './videos.service';

const errorSchema = { $ref: getSchemaPath(ApiErrorEnvelope) };

@ApiTags('videos')
@Throttle({ default: { limit: 120, ttl: 60000 } })
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Pre-register a video and start its upload',
    description:
      'Creates the video as a draft in the caller channel, starts an S3 multipart upload and returns one presigned URL per part so the client uploads directly to storage.',
  })
  @ApiResponse({ status: 201, type: VideoDraftResponseDto })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 413,
    description: 'Video exceeds the size limit',
    schema: errorSchema,
  })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<VideoDraftResponseDto> {
    return this.videosService.createDraft(user.sub, dto);
  }

  @Get(':id/upload')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get the upload state of a draft',
    description:
      'Lists the parts already stored and returns fresh presigned URLs for the missing ones, so an interrupted upload can be resumed.',
  })
  @ApiResponse({ status: 200, type: UploadStateResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid id', schema: errorSchema })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not a draft',
    schema: errorSchema,
  })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  getUploadState(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<UploadStateResponseDto> {
    return this.videosService.getUploadState(user.sub, id);
  }

  @Post(':id/upload/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete the upload and start processing',
    description:
      'Completes the multipart upload, checks the stored size, moves the video to processing and enqueues the processing job. Repeating the call while processing is idempotent.',
  })
  @ApiResponse({ status: 202, type: VideoProcessingResponseDto })
  @ApiResponse({
    status: 400,
    description: 'Invalid body, id or upload parts',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Video is ready or failed',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 413,
    description: 'Stored object exceeds the size limit',
    schema: errorSchema,
  })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<VideoProcessingResponseDto> {
    return this.videosService.completeUpload(user.sub, id, dto);
  }
}
