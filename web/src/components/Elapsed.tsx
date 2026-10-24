import { useEffect, useState } from 'react';

export function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const minutes = Math.floor(seconds / 60);
  const clock = `${minutes % 60}:${String(seconds % 60).padStart(2, '0')}`;
  return <>{minutes >= 60 ? `${Math.floor(minutes / 60)}:${clock.padStart(5, '0')}` : clock}</>;
}
