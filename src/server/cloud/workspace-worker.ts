import type {CloudApplication} from './application';
import type {CloudEvents} from './events';
import type {DurableTasks} from './tasks';
import {traceTask} from './telemetry';
import {workerServer} from './worker';

/** The single-workspace entrypoint shares durable failure handling with tenant workers. */
export function workspaceWorker(
 tasks:Pick<DurableTasks,'execute'>,
 application:Pick<CloudApplication,'execute'>,
 events:Pick<CloudEvents,'execute'|'terminal'>,
 options:Parameters<typeof workerServer>[2],
){
 return workerServer({execute:(id,run)=>tasks.execute(id,run,(spec,context)=>events.terminal(spec,context))},
  (spec,context)=>traceTask(spec,context,async()=>{
   if(spec.kind==='event')await events.execute(spec,context);
   else await application.execute(spec,context);
  }),options);
}
