import { NavLink } from 'react-router-dom';
import { LayoutDashboard, History, Heart, Activity, BookOpen } from 'lucide-react';

const links = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/history', label: 'Report History', icon: History },
  { to: '/favorites', label: 'Favorites', icon: Heart },
  { to: '/status', label: 'Run Status', icon: Activity },
];

export default function Sidebar() {
  return (
    <aside className="w-56 bg-gray-900/80 border-r border-gray-800 min-h-screen flex flex-col py-6 px-3 shrink-0">
      {/* Logo */}
      <div className="flex items-center gap-2 px-3 mb-8">
        <BookOpen size={22} className="text-purple-400" />
        <span className="text-white font-bold text-sm tracking-tight">NYT Design Bot</span>
      </div>

      {/* Nav Links */}
      <nav className="flex flex-col gap-1">
        {links.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
                isActive
                  ? 'bg-purple-500/20 text-purple-300 font-medium'
                  : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
              }`
            }
          >
            <Icon size={16} />
            {label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
