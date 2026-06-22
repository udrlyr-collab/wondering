plugins {
    id("com.android.application")
}

android {
    namespace = "com.wondering.location"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.wondering.location"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("com.google.android.gms:play-services-location:21.3.0")
}
