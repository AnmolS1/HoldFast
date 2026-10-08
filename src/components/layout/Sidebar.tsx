'use client';

import React from 'react';
import {
  Drawer,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Divider,
  Box,
  Typography,
  LinearProgress,
} from '@mui/material';
import {
  Folder,
  Share,
  Schedule,
  Delete,
  Star,
  Cloud,
} from '@mui/icons-material';

interface SidebarProps {
  open: boolean;
  onClose: () => void;
  currentView: string;
  onViewChange: (view: string) => void;
}

const sidebarWidth = 280;

export const Sidebar: React.FC<SidebarProps> = ({
  open,
  onClose,
  currentView,
  onViewChange,
}) => {
  const menuItems = [
    { id: 'my-drive', label: 'My Drive', icon: <Folder />, color: 'primary.main' },
    { id: 'shared', label: 'Shared with me', icon: <Share />, color: 'text.secondary' },
    { id: 'recent', label: 'Recent', icon: <Schedule />, color: 'text.secondary' },
    { id: 'starred', label: 'Starred', icon: <Star />, color: 'text.secondary' },
    { id: 'trash', label: 'Trash', icon: <Delete />, color: 'text.secondary' },
  ];

  // Mock storage data
  const storageUsed = 15.5; // GB
  const storageTotal = 100; // GB
  const storagePercent = (storageUsed / storageTotal) * 100;

  const drawer = (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ p: 2 }}>
        <Typography variant="h6" component="div" sx={{ fontWeight: 600 }}>
          BigStorage
        </Typography>
      </Box>
      
      <List sx={{ flexGrow: 1 }}>
        {menuItems.map((item) => (
          <ListItem key={item.id} disablePadding>
            <ListItemButton
              selected={currentView === item.id}
              onClick={() => onViewChange(item.id)}
              sx={{
                mx: 1,
                borderRadius: 1,
                '&.Mui-selected': {
                  backgroundColor: 'primary.50',
                  '&:hover': {
                    backgroundColor: 'primary.100',
                  },
                },
              }}
            >
              <ListItemIcon
                sx={{
                  color: currentView === item.id ? 'primary.main' : item.color,
                  minWidth: 40,
                }}
              >
                {item.icon}
              </ListItemIcon>
              <ListItemText 
                primary={item.label}
                primaryTypographyProps={{
                  color: currentView === item.id ? 'primary.main' : 'text.primary',
                  fontWeight: currentView === item.id ? 500 : 400,
                }}
              />
            </ListItemButton>
          </ListItem>
        ))}
      </List>

      <Divider />
      
      <Box sx={{ p: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
          <Cloud sx={{ fontSize: 20, mr: 1, color: 'text.secondary' }} />
          <Typography variant="body2" color="text.secondary">
            Storage
          </Typography>
        </Box>
        
        <LinearProgress 
          variant="determinate" 
          value={storagePercent}
          sx={{ 
            mb: 1,
            height: 6,
            borderRadius: 3,
          }}
        />
        
        <Typography variant="caption" color="text.secondary">
          {storageUsed} GB of {storageTotal} GB used
        </Typography>
      </Box>
    </Box>
  );

  return (
    <Drawer
      variant="temporary"
      anchor="left"
      open={open}
      onClose={onClose}
      ModalProps={{
        keepMounted: true,
      }}
      sx={{
        display: { xs: 'block', md: 'none' },
        '& .MuiDrawer-paper': {
          boxSizing: 'border-box',
          width: sidebarWidth,
        },
      }}
    >
      {drawer}
    </Drawer>
  );
};