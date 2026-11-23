package app.jocki;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(android.os.Bundle state) {
        registerPlugin(TimersPlugin.class);
        registerPlugin(VaultFilesPlugin.class);
        super.onCreate(state);
    }
}
