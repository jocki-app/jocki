package com.jocki.app;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import com.getcapacitor.*;
import com.getcapacitor.annotation.*;
import org.json.*;
import java.util.*;

@CapacitorPlugin(name="Timers", permissions={@Permission(alias="notifications", strings={Manifest.permission.POST_NOTIFICATIONS})})
public class TimersPlugin extends Plugin {
    @PluginMethod public void requestPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) requestPermissionForAlias("notifications",call,"permissionResult");
        else permissionResult(call);
    }
    @PermissionCallback private void permissionResult(PluginCall call) {
        JSObject result = new JSObject(); result.put("granted", Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED); call.resolve(result);
    }
    static android.content.SharedPreferences prefs(Context context) { return context.getSharedPreferences("jockiTimers",Context.MODE_PRIVATE); }
    static PendingIntent alarmIntent(Context context, int id) { return PendingIntent.getBroadcast(context,id,new Intent(context,TimerReceiver.class).setAction("alarm").putExtra("id",id),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE); }
    static PendingIntent stopIntent(Context context, int id) { return PendingIntent.getBroadcast(context,id,new Intent(context,TimerReceiver.class).setAction("stop").putExtra("id",id),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE); }
    @PluginMethod public void dismissed(PluginCall call) {
        synchronized (TimersPlugin.class) {
            Set<String> keys = new HashSet<>(prefs(getContext()).getStringSet("dismissed",new HashSet<>()));
            JSArray values = new JSArray(); for (String key:keys) { int split=key.indexOf(':'); if(split>0) { JSObject value=new JSObject();value.put("pluginId",key.substring(0,split));value.put("id",key.substring(split+1));values.put(value); } }
            if(!prefs(getContext()).edit().remove("dismissed").commit()) { call.reject("Cannot save timer dismissal");return; }
            JSObject result=new JSObject();result.put("dismissed",values);call.resolve(result);
        }
    }
    @PluginMethod public void present(PluginCall call) {
        JSArray timers=call.getArray("timers"); if(timers==null || timers.length()>32) {call.reject("Invalid timers");return;}
        try {
            Context context=getContext(); android.content.SharedPreferences store=prefs(context);
            AlarmManager alarms=(AlarmManager)context.getSystemService(Context.ALARM_SERVICE);
            NotificationManager notifications=(NotificationManager)context.getSystemService(Context.NOTIFICATION_SERVICE);
            Set<String> old=new HashSet<>(store.getStringSet("keys",new HashSet<>())), keys=new HashSet<>();
            for(int i=0;i<timers.length();i++) {
                JSONObject timer=timers.getJSONObject(i);String key=timer.getString("pluginId")+":"+timer.getString("id"); keys.add(key);
                int id=store.getInt("id:"+key,0); if(id==0) {id=store.getInt("nextID",10000); if(!store.edit().putInt("id:"+key,id).putInt("nextID",id+1).commit()) throw new Exception("Cannot persist timer ID");}
                double start=timer.getDouble("startedAt"); if(!Double.isFinite(start)||start<0) throw new Exception("Invalid timer start");
                String previous=store.getString("timer:"+id,null); if(previous!=null && new JSONObject(previous).optDouble("startedAt")!=start) store.edit().remove("fired:"+id).commit();
                if(!store.edit().putString("timer:"+id,timer.toString()).commit()) throw new Exception("Cannot save native timer");
                alarms.cancel(alarmIntent(context,id));
                boolean paused=!timer.isNull("pausedAt"); long duration=timer.optLong("durationMs",0), due=(long)start+timer.optLong("pausedMs",0)+duration;
                if(duration>0 && !paused && due<=System.currentTimeMillis()) { TimerReceiver.fire(context,id);continue; }
                if(duration>0 && !paused) {
                    if(Build.VERSION.SDK_INT<31 || alarms.canScheduleExactAlarms()) alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP,due,alarmIntent(context,id));
                    else alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP,due,alarmIntent(context,id));
                }
                if(Build.VERSION.SDK_INT>=26) notifications.createNotificationChannel(new NotificationChannel("jocki-timers","Running timers",NotificationManager.IMPORTANCE_LOW));
                PendingIntent launch=PendingIntent.getActivity(context,0,new Intent(context,MainActivity.class),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
                NotificationCompat.Builder builder=new NotificationCompat.Builder(context,"jocki-timers").setSmallIcon(android.R.drawable.ic_lock_idle_alarm).setContentTitle(timer.optString("title","Timer")).setContentText(paused?"Paused":duration>0?"Time remaining":"Tracking time").setOngoing(true).setOnlyAlertOnce(true).setContentIntent(launch).setWhen(duration>0?due:(long)start+timer.optLong("pausedMs",0)).setUsesChronometer(!paused);
                if(Build.VERSION.SDK_INT>=24) builder.setChronometerCountDown(duration>0);
                notifications.notify(id,builder.build());
            }
            for(String key:old) if(!keys.contains(key)) {int id=store.getInt("id:"+key,0);alarms.cancel(alarmIntent(context,id));notifications.cancel(id);store.edit().remove("timer:"+id).remove("fired:"+id).commit();}
            if(!store.edit().putStringSet("keys",keys).commit()) throw new Exception("Cannot persist native timers");
            call.resolve();
        } catch(Exception error) {call.reject("Unable to present native timers",error);}
    }
}
