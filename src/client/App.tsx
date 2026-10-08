import Box from "@mui/material/Box";
import CssBaseline from "@mui/material/CssBaseline";
import { createTheme, ThemeProvider } from "@mui/material/styles";
import Typography from "@mui/material/Typography";

// Minimal theme. The real design tokens replace it with the application shell.
const theme = createTheme({
  colorSchemes: { light: true, dark: true },
});

export function App() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box component="main" sx={{ minHeight: "100dvh", display: "grid", placeItems: "center", p: 3 }}>
        <Typography component="h1" variant="h4">
          Holdfast
        </Typography>
      </Box>
    </ThemeProvider>
  );
}
