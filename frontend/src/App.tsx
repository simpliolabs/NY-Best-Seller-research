import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import Dashboard from './pages/Dashboard';
import History from './pages/History';
import ReportDetail from './pages/ReportDetail';
import BookDetail from './pages/BookDetail';
import Favorites from './pages/Favorites';
import Status from './pages/Status';

export default function App() {
  return (
    <BrowserRouter>
      <div className="flex min-h-screen bg-[#0f0f14]">
        <Sidebar />
        <main className="flex-1 p-8 overflow-y-auto">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/history" element={<History />} />
            <Route path="/report/:runId" element={<ReportDetail />} />
            <Route path="/book/:id" element={<BookDetail />} />
            <Route path="/favorites" element={<Favorites />} />
            <Route path="/status" element={<Status />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
