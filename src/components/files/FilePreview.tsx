'use client';

import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  Typography,
  CircularProgress,
  IconButton,
  Alert,
} from '@mui/material';
import {
  Close,
  Download,
  Share,
  ZoomIn,
  ZoomOut,
  RotateRight,
} from '@mui/icons-material';
import { FileItem } from '@/types';
import { isPreviewable } from '@/utils/file-utils';

interface FilePreviewProps {
  file: FileItem | null;
  open: boolean;
  onClose: () => void;
}

export const FilePreview: React.FC<FilePreviewProps> = ({
  file,
  open,
  onClose,
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [zoom, setZoom] = useState(100);
  const [rotation, setRotation] = useState(0);

  useEffect(() => {
    if (file && open && isPreviewable(file.mimeType || '')) {
      loadFileContent();
    }
  }, [file, open]);

  const loadFileContent = async () => {
    if (!file?.url) return;

    setLoading(true);
    setError(null);

    try {
      if (file.mimeType?.startsWith('text/') || file.mimeType === 'application/json') {
        const response = await fetch(file.url);
        if (!response.ok) throw new Error('Failed to load file');
        const text = await response.text();
        setContent(text);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load file');
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = () => {
    if (file?.url) {
      const link = document.createElement('a');
      link.href = file.url;
      link.download = file.name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  const renderPreview = () => {
    if (!file) return null;

    if (loading) {
      return (
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            minHeight: 300,
          }}
        >
          <CircularProgress />
        </Box>
      );
    }

    if (error) {
      return (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      );
    }

    const mimeType = file.mimeType || '';

    // Image preview
    if (mimeType.startsWith('image/')) {
      return (
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            overflow: 'auto',
            maxHeight: 500,
          }}
        >
          <img
            src={file.url}
            alt={file.name}
            style={{
              maxWidth: '100%',
              maxHeight: '100%',
              transform: `scale(${zoom / 100}) rotate(${rotation}deg)`,
              transition: 'transform 0.2s ease',
            }}
          />
        </Box>
      );
    }

    // PDF preview
    if (mimeType === 'application/pdf') {
      return (
        <Box sx={{ height: 500 }}>
          <iframe
            src={file.url}
            width="100%"
            height="100%"
            style={{ border: 'none' }}
            title={file.name}
          />
        </Box>
      );
    }

    // Text preview
    if (mimeType.startsWith('text/') || mimeType === 'application/json') {
      return (
        <Box
          component="pre"
          sx={{
            bgcolor: 'grey.100',
            p: 2,
            borderRadius: 1,
            overflow: 'auto',
            maxHeight: 400,
            fontSize: '0.875rem',
            fontFamily: 'monospace',
            whiteSpace: 'pre-wrap',
          }}
        >
          {content}
        </Box>
      );
    }

    return (
      <Alert severity="info">
        Preview not available for this file type. Click download to view the file.
      </Alert>
    );
  };

  const isImage = file?.mimeType?.startsWith('image/');

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      PaperProps={{
        sx: { minHeight: 400 }
      }}
    >
      <DialogTitle
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Typography variant="h6" noWrap>
          {file?.name || 'File Preview'}
        </Typography>
        <Box sx={{ display: 'flex', gap: 1 }}>
          {isImage && (
            <>
              <IconButton
                onClick={() => setZoom(Math.max(25, zoom - 25))}
                disabled={zoom <= 25}
                size="small"
              >
                <ZoomOut />
              </IconButton>
              <Typography variant="body2" sx={{ minWidth: 40, textAlign: 'center', alignSelf: 'center' }}>
                {zoom}%
              </Typography>
              <IconButton
                onClick={() => setZoom(Math.min(200, zoom + 25))}
                disabled={zoom >= 200}
                size="small"
              >
                <ZoomIn />
              </IconButton>
              <IconButton
                onClick={() => setRotation((rotation + 90) % 360)}
                size="small"
              >
                <RotateRight />
              </IconButton>
            </>
          )}
          <IconButton onClick={handleDownload} size="small">
            <Download />
          </IconButton>
          <IconButton size="small">
            <Share />
          </IconButton>
          <IconButton onClick={onClose} size="small">
            <Close />
          </IconButton>
        </Box>
      </DialogTitle>

      <DialogContent>
        {renderPreview()}
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        <Button onClick={handleDownload} variant="contained">
          Download
        </Button>
      </DialogActions>
    </Dialog>
  );
};