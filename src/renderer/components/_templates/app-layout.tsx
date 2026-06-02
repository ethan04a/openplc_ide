import {
  ConfirmDeleteModalProps,
  SaveChangeModalProps,
  SaveChangesFileModalData,
} from '@root/renderer/components/_organisms/modals'
import { useOpenPLCStore } from '@root/renderer/store'
import { ComponentPropsWithoutRef, ReactNode, useEffect } from 'react'

import Toaster from '../_features/[app]/toast/toaster'
import { ProjectModal } from '../_features/[start]/new-project/project-modal'
import {
  ConfirmDeleteElementModal,
  QuitApplicationModal,
  SaveChangesFileModal,
  SaveChangesModal,
} from '../_organisms/modals'
import { AcceleratorHandler } from './accelerator-handler'

type AppLayoutProps = ComponentPropsWithoutRef<'main'>
const AppLayout = ({ children, ...rest }: AppLayoutProps): ReactNode => {
  const {
    modals,
    workspaceActions: { setSystemConfigs, setRecent },
  } = useOpenPLCStore()

  useEffect(() => {
    const getUserSystemProps = async () => {
      const { OS, architecture, prefersDarkMode, isWindowMaximized } = await window.bridge.getSystemInfo()
      const recent = await window.bridge.retrieveRecent()

      setRecent(recent)
      setSystemConfigs({
        OS,
        arch: architecture,
        shouldUseDarkMode: prefersDarkMode,
        isWindowMaximized,
      })
    }
    void getUserSystemProps()
  }, [setSystemConfigs, setRecent])

  return (
    <>
      <main className='absolute inset-0 flex overflow-hidden' {...rest}>
        {children}
        <Toaster />
        {modals?.['create-project']?.open === true && <ProjectModal isOpen={modals['create-project'].open} />}
        {modals?.['save-changes-project']?.open === true && (
          <SaveChangesModal
            isOpen={modals['save-changes-project'].open}
            validationContext={(modals['save-changes-project'].data as SaveChangeModalProps).validationContext}
            recentResponse={(modals['save-changes-project'].data as SaveChangeModalProps).recentResponse}
          />
        )}
        {modals?.['save-changes-file']?.open === true && (
          <SaveChangesFileModal
            isOpen={modals['save-changes-file'].open}
            data={modals['save-changes-file'].data as SaveChangesFileModalData}
          />
        )}
        {modals?.['quit-application']?.open === true && (
          <QuitApplicationModal isOpen={modals['quit-application'].open} />
        )}
        {modals?.['confirm-delete-element']?.open === true && (
          <ConfirmDeleteElementModal
            isOpen={modals['confirm-delete-element'].open}
            data={modals['confirm-delete-element'].data as ConfirmDeleteModalProps['data']}
          />
        )}
        <AcceleratorHandler />
      </main>
    </>
  )
}

export { AppLayout }
