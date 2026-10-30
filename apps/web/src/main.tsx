import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

function App() {
  return <h1>Paceo</h1>;
}

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
