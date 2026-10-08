'use client';

import React, { useState } from 'react';
import { Box, Drawer, useMediaQuery, useTheme } from '@mui/material';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { FileExplorer } from '../files/FileExplorer';
import { RecentFiles } from '../files/RecentFiles';
import { SharedFiles } from '../files/SharedFiles';
import { TrashFiles } from '../files/TrashFiles';

const drawerWidth = 280;

export const MainLayout: React.FC = () => {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  const [mobileOpen, setMobileOpen] = useState(false);
  const [currentView, setCurrentView] = useState('my-drive');

  const handleDrawerToggle = () => {
    setMobileOpen(!mobileOpen);
  };

  const handleViewChange = (view: string) => {
    setCurrentView(view);
    if (isMobile) {
      setMobileOpen(false);
    }
  };

  const renderMainContent = () => {
    switch (currentView) {
      case 'recent':
        return <RecentFiles />;
      case 'shared':
        return <SharedFiles />;
      case 'trash':
        return <TrashFiles />;
      case 'my-drive':
      default:
        return <FileExplorer />;
    }
  };

  const drawer = (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ p: 2 }}>
        <Box sx={{ fontWeight: 600, fontSize: '1.25rem' }}>
          BigStorage
        </Box>
      </Box>
      <Sidebar
        open={true}
        onClose={() => {}}
        currentView={currentView}
        onViewChange={handleViewChange}
      />
    </Box>
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh' }}>
      <Header onMenuClick={handleDrawerToggle} />
      
      <Box
        component="nav"
        sx={{ width: { md: drawerWidth }, flexShrink: { md: 0 } }}
      >
        {/* Mobile drawer */}
        <Drawer
          variant="temporary"
          open={mobileOpen}
          onClose={handleDrawerToggle}
          ModalProps={{
            keepMounted: true,
          }}
          sx={{
            display: { xs: 'block', md: 'none' },
            '& .MuiDrawer-paper': {
              boxSizing: 'border-box',
              width: drawerWidth,
            },
          }}
        >
          {drawer}
        </Drawer>
        
        {/* Desktop drawer */}
        <Drawer
          variant="permanent"
          sx={{
            display: { xs: 'none', md: 'block' },
            '& .MuiDrawer-paper': {
              boxSizing: 'border-box',
              width: drawerWidth,
              position: 'relative',
              height: '100vh',
            },
          }}
          open
        >
          {drawer}
        </Drawer>
      </Box>

      <Box
        component="main"
        sx={{
          flexGrow: 1,
          width: { md: `calc(100% - ${drawerWidth}px)` },
          minHeight: '100vh',
          bgcolor: 'background.default',
        }}
      >
        <Box sx={{ pt: { xs: 8, md: 8 } }}>
          {renderMainContent()}
        </Box>
      </Box>
    </Box>
  );
};