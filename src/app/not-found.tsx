const NotFound = () => {
  return (
    <main className='flex min-bs-[100dvh] flex-col items-center justify-center gap-4 p-6 text-center'>
      <h1 className='text-4xl font-semibold'>404</h1>
      <p className='text-textSecondary'>页面不存在</p>
      <a className='text-primary' href='/'>
        返回渠道管理
      </a>
    </main>
  )
}

export default NotFound
