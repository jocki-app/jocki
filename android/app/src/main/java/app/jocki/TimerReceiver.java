package app.jocki;
import android.app.*;
import android.content.*;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import org.json.*;
import java.util.*;
public class TimerReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        int id=intent.getIntExtra("id",0);if(id<10000)return;
        if("stop".equals(intent.getAction())) {
            try { JSONObject timer=new JSONObject(TimersPlugin.prefs(context).getString("timer:"+id,"{}"));String key=timer.getString("pluginId")+":"+timer.getString("id");synchronized(TimersPlugin.class) {Set<String> dismissed=new HashSet<>(TimersPlugin.prefs(context).getStringSet("dismissed",new HashSet<>()));dismissed.add(key);TimersPlugin.prefs(context).edit().putStringSet("dismissed",dismissed).commit();} } catch(Exception ignored){}
            ((NotificationManager)context.getSystemService(Context.NOTIFICATION_SERVICE)).cancel(id);
        } else if("alarm".equals(intent.getAction())) fire(context,id);
    }
    static void fire(Context context,int id) {
        try {
            android.content.SharedPreferences store=TimersPlugin.prefs(context);if(store.getBoolean("fired:"+id,false))return;
            JSONObject timer=new JSONObject(store.getString("timer:"+id,"{}")), alert=timer.optJSONObject("alert");String tone=alert==null?"none":alert.optString("tone","none");boolean repeated=alert!=null&&"indefinite".equals(alert.optString("repeat"));
            if(!Arrays.asList("none","chime","bell","gentle").contains(tone))return;
            NotificationManager notifications=(NotificationManager)context.getSystemService(Context.NOTIFICATION_SERVICE);
            String vibration=alert==null?"none":alert.optString("vibration","none");long[] pattern="pulse".equals(vibration)?new long[]{0,150,100,150}:"short".equals(vibration)?new long[]{0,150}:new long[]{0};
            String channel="jocki-alarm-"+tone+"-"+vibration;Uri sound="none".equals(tone)?null:Uri.parse("android.resource://"+context.getPackageName()+"/raw/"+tone);
            if(Build.VERSION.SDK_INT>=26){NotificationChannel config=new NotificationChannel(channel,"Timer alerts: "+tone,NotificationManager.IMPORTANCE_HIGH);config.enableVibration(!"none".equals(vibration));config.setVibrationPattern(pattern);config.setSound(sound,new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build());notifications.createNotificationChannel(config);}
            NotificationCompat.Builder builder=new NotificationCompat.Builder(context,channel).setSmallIcon(android.R.drawable.ic_lock_idle_alarm).setContentTitle("Timer finished").setContentText(timer.optString("title","Timer")).setCategory(NotificationCompat.CATEGORY_ALARM).setPriority(NotificationCompat.PRIORITY_HIGH).setAutoCancel(!repeated).addAction(android.R.drawable.ic_media_pause,"Stop alert",TimersPlugin.stopIntent(context,id)).setDeleteIntent(TimersPlugin.stopIntent(context,id));
            builder.setVibrate(pattern);if(sound!=null)builder.setSound(sound);Notification notification=builder.build();if(repeated&&sound!=null)notification.flags|=Notification.FLAG_INSISTENT;
            if(!store.edit().putBoolean("fired:"+id,true).commit())return;notifications.notify(id,notification);
        } catch(Exception ignored) { /* Never schedule or execute plugin code from an alarm broadcast. */ }
    }
}
