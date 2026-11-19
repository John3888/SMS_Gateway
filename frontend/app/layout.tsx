import "./globals.css";
export const metadata = { title: "Gateway Monitor | SMS administration" };
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
