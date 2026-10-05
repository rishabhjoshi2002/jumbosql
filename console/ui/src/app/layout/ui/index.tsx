import { FC } from 'react';
import Sidebar from '@widgets/sidebar';
import Header from '@widgets/header';
import Main from '@widgets/main';
import Watermark from '@shared/ui/watermark';

const Layout: FC = () => {
  return (
    <div style={{ display: 'flex', overflow: 'auto', height: '100vh' }}>
      <Watermark />
      <Header />
      <Sidebar />
      <Main />
    </div>
  );
};

export default Layout;
